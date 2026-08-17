@tool
class_name LunarTerrainLiveSync
extends Node
## Keeps an imported Godot terrain byte-aligned with the live sidecar dataset.
##
## The synchronizer polls the cheap sequence head, fetches every missed delta in
## order, verifies checksum chaining before and after mutation, applies sparse
## height and semantic-mask payloads in place, and rebuilds only scene chunks
## intersecting the changed bounds. Oversized height or semantic changes fall
## back to stride-1 terrain.getTile requests. A pruned sequence or checksum
## divergence is never guessed through: the owner is told to perform a
## validated full resync.

signal state_changed(state: String, detail: String)
signal delta_applied(sequence_number: int, delta_id: String, changed_sample_count: int)
signal resync_required(head_sequence: int, reason: String)
signal sync_failed(reason: String)

const POLL_INTERVAL_SECONDS := 0.5
const REQUEST_TIMEOUT_SECONDS := 15.0
const MAX_ROCK_INSTANCES := 50_000
const ROCK_TRANSFER_DIGEST_PREFIX := "LTS_ROCK_TRANSFER_V1"
const ROCK_TRANSFER_ENCODING := "base64:lts-rock-transfer-v1"
const MAX_ROCK_ID_BYTES := 256
# Prefix + count + 50,000 maximum-size records. This remains well below the
# sidecar client's 128 MiB inbound frame ceiling and is checked before decode.
const MAX_ROCK_TRANSFER_BYTES := 17_050_025
const MAX_ROCK_TRANSFER_BASE64_CHARS := 22_733_368
const FLOAT64_RELATIVE_EPSILON := 2.220446049250313e-16
const REQUIRED_COORDINATE_FIELDS := [
	"handedness",
	"up_axis",
	"east_axis",
	"north_axis",
	"south_axis",
	"linear_unit",
	"angular_unit",
	"note",
	"body_frame",
	"body_radius_m",
]
const SOURCE_PROJECTION_STRING_FIELDS := ["type"]
const SOURCE_PROJECTION_NUMBER_FIELDS := [
	"latitudeOfOriginDeg",
	"centralMeridianDeg",
	"scaleFactor",
	"falseEastingM",
	"falseNorthingM",
	"bodyRadiusM",
	"originEastingM",
	"originNorthingM",
]
const PROVENANCE_IDENTITY_FIELDS := [
	"generator",
	"seeds",
	"dataSources",
	"literatureModels",
	"syntheticHeuristics",
	"limitations",
	"configurationHash",
]

var client: RefCounted = null
var loader: RefCounted = null
var terrain_root: Node3D = null
var next_sequence := 0
## Monotonic server world revision paired with next_sequence (protocol 2.x).
var dataset_revision := -1
var active := false
var baseline_verified := false
## Last successful/selected transfer path, exposed for diagnostics and tests.
var last_transport := "none"
## Counts returned by the most recent bounded visual/collision refresh.
var last_refresh: Dictionary = {}
## Whether the last applied delta required a complete rock-instance transfer.
var last_rock_refresh := "none"

var _elapsed := 0.0
var _pending: Dictionary = {}
var _waiting := false
var _request_elapsed := 0.0
var _queued_delta: Dictionary = {}
var _baseline_immutable_sha := ""
var _baseline_world_sha := ""
var _baseline_rock_transfer_sha := ""
## One in-flight local transaction. Height and semantic arrays are restored if
## any later channel fetch/apply, checksum, or scene refresh rejects the delta.
var _delta_transaction: Dictionary = {}


func configure(
	client_ref: RefCounted,
	loader_ref: RefCounted,
	root_ref: Node3D,
	initial_sequence: int = 0
) -> void:
	stop()
	client = client_ref
	loader = loader_ref
	terrain_root = root_ref
	next_sequence = maxi(0, initial_sequence)
	dataset_revision = -1
	baseline_verified = false
	last_transport = "none"
	last_refresh.clear()
	last_rock_refresh = "none"
	_queued_delta.clear()
	_baseline_immutable_sha = ""
	_baseline_world_sha = ""
	_baseline_rock_transfer_sha = ""
	if client != null and not client.response.is_connected(_on_response):
		client.response.connect(_on_response)
	state_changed.emit("ready", "baseline sequence %d" % next_sequence)


func start() -> void:
	if client == null or loader == null or terrain_root == null:
		_fail("live sync is not configured with a client, loader, and terrain root")
		return
	active = true
	_elapsed = POLL_INTERVAL_SECONDS
	state_changed.emit("live", "watching from sequence %d" % next_sequence)


func stop() -> void:
	_rollback_delta_transaction()
	active = false
	baseline_verified = false
	dataset_revision = -1
	_waiting = false
	_request_elapsed = 0.0
	_pending.clear()
	_queued_delta.clear()
	_baseline_immutable_sha = ""
	_baseline_world_sha = ""
	_baseline_rock_transfer_sha = ""
	_elapsed = 0.0


func has_applied_through(sequence_number: int) -> bool:
	return active and baseline_verified and not _waiting and next_sequence >= sequence_number


func _exit_tree() -> void:
	_rollback_delta_transaction()
	if client != null and client.response.is_connected(_on_response):
		client.response.disconnect(_on_response)


func _process(delta: float) -> void:
	if not active:
		return
	if _waiting:
		_request_elapsed += delta
		if _request_elapsed >= REQUEST_TIMEOUT_SECONDS:
			_fail("live sync request timed out after %.1f seconds" % REQUEST_TIMEOUT_SECONDS)
		return
	if not client.is_connected_to_sidecar():
		return
	_elapsed += delta
	if _elapsed < POLL_INTERVAL_SECONDS:
		return
	_elapsed = 0.0
	var params := {"sequenceNumber": next_sequence}
	if dataset_revision > 0:
		params["datasetRevision"] = dataset_revision
	_request("terrain.getChangedSince", params, {"kind": "poll"})


## Accept a delta already returned by terrain.applyOperation without waiting for
## the next poll. Out-of-order responses fall back to the ordered fetch path.
func accept_delta(delta: Dictionary) -> void:
	if not active or not baseline_verified:
		return
	if int(delta.get("datasetRevision", -1)) != dataset_revision:
		_require_resync(
			int(delta.get("sequenceNumber", next_sequence)) + 1,
			"operation delta belongs to dataset revision %s, expected %d"
			% [delta.get("datasetRevision", "missing"), dataset_revision]
		)
		return
	var sequence := int(delta.get("sequenceNumber", -1))
	if sequence < next_sequence:
		return
	# A poll or tile/rock fetch may already own the single request lane. Keep the
	# authoritative applyOperation delta and consume it as soon as that response
	# completes; dropping it here previously left rocks stale after rapid edits.
	if _waiting:
		if _queued_delta.is_empty() or sequence < int(_queued_delta.get("sequenceNumber", 2_147_483_647)):
			_queued_delta = delta.duplicate(true)
		return
	if sequence > next_sequence:
		_request(
			"terrain.getDelta",
			{"sequenceNumber": next_sequence, "datasetRevision": dataset_revision},
			{"kind": "delta"}
		)
		return
	_apply_or_fetch_tile(delta)


func _request(method: String, params: Dictionary, context: Dictionary) -> void:
	if _waiting:
		return
	var id: int = client.call_method(method, params)
	if id < 0:
		_fail("%s could not be sent: %s" % [method, client.last_error])
		return
	_pending[id] = context
	_waiting = true
	_request_elapsed = 0.0


func _on_response(id: int, result: Variant, error: Dictionary) -> void:
	if not _pending.has(id):
		return
	var context: Dictionary = _pending[id]
	_pending.erase(id)
	_waiting = false
	_request_elapsed = 0.0

	if not error.is_empty():
		_handle_error(context, error)
		return

	match String(context.get("kind", "")):
		"poll":
			_handle_poll(result as Dictionary)
		"baseline_dataset":
			_finish_baseline_dataset(result as Dictionary)
		"baseline_rocks":
			_finish_baseline_rocks(result as Dictionary)
		"delta":
			_apply_or_fetch_tile(result as Dictionary)
		"tile":
			_finish_tile(result as Dictionary, context.get("delta", {}) as Dictionary)
		"mask_tile":
			_finish_mask_tile(
				result as Dictionary,
				context.get("delta", {}) as Dictionary,
				context.get("changed_bounds", {}) as Dictionary
			)
		"rocks":
			_finish_rocks(result as Dictionary, context.get("delta", {}) as Dictionary)
		_:
			_fail("live sync received an unknown response context")
	_drain_queued_delta()


func _drain_queued_delta() -> void:
	if _waiting or _queued_delta.is_empty() or not active:
		return
	var delta := _queued_delta
	_queued_delta = {}
	accept_delta(delta)


func _handle_poll(result: Dictionary) -> void:
	var head := int(result.get("toSequence", -1))
	var revision := int(result.get("datasetRevision", -1))
	if dataset_revision < 0:
		if revision < 1 or head < 0 or not _verify_baseline_channels(result):
			_require_resync(maxi(0, head), "imported terrain does not match the live sidecar baseline")
			return
		dataset_revision = revision
		next_sequence = head
		state_changed.emit("verifying", "checking immutable dataset identity and rock physics")
		_request("terrain.getDataset", {}, {"kind": "baseline_dataset"})
		return
	if revision != dataset_revision:
		_require_resync(
			maxi(0, head),
			"sidecar dataset revision changed from %d to %d" % [dataset_revision, revision]
		)
		return
	if head < next_sequence:
		_require_resync(head, "the sidecar sequence reset behind the imported baseline")
		return
	if head == next_sequence:
		state_changed.emit("current", "sequence %d" % next_sequence)
		return
	_request(
		"terrain.getDelta",
		{"sequenceNumber": next_sequence, "datasetRevision": dataset_revision},
		{"kind": "delta"}
	)


func _verify_baseline_channels(result: Dictionary) -> bool:
	if String(result.get("terrainId", "")) != String(loader.manifest.get("terrainId", "")):
		return false
	if String(result.get("seed", "")) != String(loader.manifest.get("seed", "")):
		return false
	var baseline_variant: Variant = result.get("baseline")
	if typeof(baseline_variant) != TYPE_DICTIONARY:
		return false
	var baseline: Dictionary = baseline_variant
	if int(baseline.get("schemaVersion", -1)) != 1:
		return false
	_baseline_immutable_sha = String(baseline.get("immutableIdentitySha256", ""))
	_baseline_world_sha = String(baseline.get("worldStateSha256", ""))
	var rocks_variant: Variant = baseline.get("rocks")
	if typeof(rocks_variant) != TYPE_DICTIONARY:
		return false
	_baseline_rock_transfer_sha = String((rocks_variant as Dictionary).get("transferSha256", ""))
	if (
		not _valid_sha256(_baseline_immutable_sha)
		or not _valid_sha256(_baseline_world_sha)
		or not _valid_sha256(_baseline_rock_transfer_sha)
	):
		return false
	var heads_variant: Variant = baseline.get("layers")
	if typeof(heads_variant) != TYPE_ARRAY:
		return false
	var heads: Array = heads_variant
	for layer in loader.layers:
		var layer_id := String(layer.id)
		var expected: Dictionary = {}
		for head_variant in heads:
			if typeof(head_variant) == TYPE_DICTIONARY and String(head_variant.get("layerId", "")) == layer_id:
				expected = head_variant
				break
		if expected.is_empty():
			return false
		if not _verify_layer_checksum(layer_id, String(expected.get("heightSha256", "")), "height"):
			return false
		if not _verify_layer_checksum(layer_id, String(expected.get("semanticSha256", "")), "semantic"):
			return false
		if not _verify_layer_checksum(
			layer_id, String(expected.get("elevationSourceSha256", "")), "elevation_source"
		):
			return false
		# Disturbance is not a Godot-consumed/exported channel. Refuse to call a
		# baseline current if the authority has one that this import cannot bind.
		if expected.get("disturbanceSha256", null) != null:
			return false
	return heads.size() == loader.layers.size()


func _finish_baseline_dataset(payload: Dictionary) -> void:
	if (
		int(payload.get("datasetRevision", -1)) != dataset_revision
		or int(payload.get("sequenceNumber", -1)) != next_sequence
	):
		_require_resync(next_sequence, "sidecar state changed during baseline identity verification")
		return
	var baseline: Dictionary = payload.get("baseline", {}) as Dictionary
	if (
		String(baseline.get("immutableIdentitySha256", "")) != _baseline_immutable_sha
		or String(baseline.get("worldStateSha256", "")) != _baseline_world_sha
		or not _verify_dataset_identity(payload)
	):
		_require_resync(next_sequence, "imported geometry, origin, or configuration does not match the sidecar")
		return
	_request(
		"terrain.getRocks",
		{"maxInstances": MAX_ROCK_INSTANCES},
		{"kind": "baseline_rocks"}
	)


func _finish_baseline_rocks(payload: Dictionary) -> void:
	var verified := _verified_baseline_rock_response(payload)
	if not bool(verified.get("ok", false)):
		_require_resync(
			maxi(next_sequence, int(payload.get("sequenceNumber", next_sequence))),
			"sidecar state changed during baseline rock verification"
		)
		return
	if bool(payload.get("truncated", false)):
		_require_resync(
			next_sequence,
			"baseline rock transfer returned %d of %d instances"
			% [int(payload.get("returnedCount", 0)), int(payload.get("totalCount", 0))]
		)
		return
	var replaced: Dictionary = loader.replace_rocks(
		terrain_root, verified.get("payload", {}) as Dictionary
	)
	if not bool(replaced.get("ok", false)):
		_require_resync(
			next_sequence,
			"baseline rock verification failed: %s" % replaced.get("error", "unknown")
		)
		return
	baseline_verified = true
	state_changed.emit("current", "revision %d · sequence %d" % [dataset_revision, next_sequence])


func _rock_response_matches_baseline(payload: Dictionary) -> bool:
	return bool(_verified_baseline_rock_response(payload).get("ok", false))


func _verified_baseline_rock_response(payload: Dictionary) -> Dictionary:
	if int(payload.get("datasetRevision", -1)) != dataset_revision:
		return {"ok": false}
	if int(payload.get("sequenceNumber", -1)) != next_sequence:
		return {"ok": false}
	if String(payload.get("terrainId", "")) != String(loader.manifest.get("terrainId", "")):
		return {"ok": false}
	if String(payload.get("seed", "")) != String(loader.manifest.get("seed", "")):
		return {"ok": false}
	var baseline: Dictionary = payload.get("baseline", {}) as Dictionary
	var baseline_rocks: Dictionary = baseline.get("rocks", {}) as Dictionary
	if not (
		String(baseline.get("immutableIdentitySha256", "")) == _baseline_immutable_sha
		and String(baseline.get("worldStateSha256", "")) == _baseline_world_sha
		and String(baseline_rocks.get("transferSha256", "")) == _baseline_rock_transfer_sha
	):
		return {"ok": false}
	return _verified_rock_transfer(payload, _baseline_rock_transfer_sha)


func _verify_dataset_identity(payload: Dictionary) -> bool:
	if String(payload.get("terrainId", "")) != String(loader.manifest.get("terrainId", "")):
		return false
	if String(payload.get("seed", "")) != String(loader.manifest.get("seed", "")):
		return false
	var live_coordinate_variant: Variant = payload.get("coordinateSystem")
	var imported_coordinate_variant: Variant = loader.manifest.get("coordinate_system")
	if (
		typeof(live_coordinate_variant) != TYPE_DICTIONARY
		or typeof(imported_coordinate_variant) != TYPE_DICTIONARY
	):
		return false
	var live_coordinate: Dictionary = live_coordinate_variant
	var imported_coordinate: Dictionary = imported_coordinate_variant
	for key in REQUIRED_COORDINATE_FIELDS:
		if not live_coordinate.has(key) or not imported_coordinate.has(key):
			return false
		if key == "body_radius_m":
			if not _same_number(live_coordinate.get(key), imported_coordinate.get(key)):
				return false
		elif live_coordinate.get(key) != imported_coordinate.get(key):
			return false
	# Unknown or newly introduced coordinate fields are identity too. Refuse a
	# one-sided or changed value rather than silently accepting semantics this
	# client ignored.
	for key in imported_coordinate:
		if key == "source_projection":
			continue
		if not live_coordinate.has(key) or live_coordinate.get(key) != imported_coordinate.get(key):
			return false
	for key in live_coordinate:
		if key != "source_projection" and not imported_coordinate.has(key):
			return false
	if not _same_source_projection(live_coordinate, imported_coordinate):
		return false

	var live_origin_variant: Variant = payload.get("origin")
	var imported_origin_variant: Variant = loader.manifest.get("origin")
	if (
		typeof(live_origin_variant) != TYPE_DICTIONARY
		or typeof(imported_origin_variant) != TYPE_DICTIONARY
	):
		return false
	var live_origin: Dictionary = live_origin_variant
	var imported_origin: Dictionary = imported_origin_variant
	var live_local_variant: Variant = live_origin.get("local")
	var imported_local_variant: Variant = imported_origin.get("local")
	if (
		typeof(live_local_variant) != TYPE_DICTIONARY
		or typeof(imported_local_variant) != TYPE_ARRAY
		or (imported_local_variant as Array).size() != 3
	):
		return false
	var live_local: Dictionary = live_local_variant
	var imported_local: Array = imported_local_variant
	if live_local.size() != 3:
		return false
	for pair in [
		[live_local.get("x"), imported_local[0]],
		[live_local.get("y"), imported_local[1]],
		[live_local.get("z"), imported_local[2]],
	]:
		if not _same_number(pair[0], pair[1]):
			return false
	var live_site_variant: Variant = live_origin.get("site")
	var imported_site_variant: Variant = imported_origin.get("site_selenographic")
	if (
		typeof(live_site_variant) != TYPE_DICTIONARY
		or typeof(imported_site_variant) != TYPE_DICTIONARY
	):
		return false
	var live_site: Dictionary = live_site_variant
	var imported_site: Dictionary = imported_site_variant
	if (
		not _same_number(live_site.get("latitudeDeg"), imported_site.get("latitude_deg"))
		or not _same_number(live_site.get("longitudeDeg"), imported_site.get("longitude_deg"))
		or not _same_number(live_origin.get("datumElevationM"), imported_origin.get("datum_elevation_m"))
	):
		return false

	var live_layers_variant: Variant = payload.get("layers")
	var imported_layers_variant: Variant = loader.manifest.get("layers")
	if typeof(live_layers_variant) != TYPE_ARRAY or typeof(imported_layers_variant) != TYPE_ARRAY:
		return false
	var live_layers: Array = live_layers_variant
	var imported_layers: Array = imported_layers_variant
	if live_layers.size() != imported_layers.size():
		return false
	for imported_variant in imported_layers:
		if typeof(imported_variant) != TYPE_DICTIONARY:
			return false
		var imported: Dictionary = imported_variant
		var live: Dictionary = {}
		for live_variant in live_layers:
			if typeof(live_variant) == TYPE_DICTIONARY and live_variant.get("id") == imported.get("id"):
				live = live_variant
				break
		if live.is_empty():
			return false
		if (
			live.get("role") != imported.get("role")
			or int(live.get("widthSamples", -1)) != int(imported.get("width_samples", -2))
			or int(live.get("heightSamples", -1)) != int(imported.get("height_samples", -2))
			or not _same_number(live.get("resolutionMeters"), imported.get("resolution_m"))
			or live.get("elevationProvenance") != imported.get("elevation_provenance")
		):
			return false
		var live_source: Variant = live.get("sourceEffectiveResolutionMeters")
		var imported_source: Variant = imported.get("source_effective_resolution_m")
		if (
			not live.has("sourceEffectiveResolutionMeters")
			or not imported.has("source_effective_resolution_m")
		):
			return false
		if (live_source == null) != (imported_source == null):
			return false
		if live_source != null and not _same_number(live_source, imported_source):
			return false
		var live_bounds: Dictionary = live.get("bounds", {}) as Dictionary
		var imported_bounds: Dictionary = imported.get("bounds", {}) as Dictionary
		var minimum: Array = imported_bounds.get("minimum", []) as Array
		var maximum: Array = imported_bounds.get("maximum", []) as Array
		if minimum.size() != 3 or maximum.size() != 3:
			return false
		for pair in [
			[live_bounds.get("minX"), minimum[0]],
			[live_bounds.get("minY"), minimum[1]],
			[live_bounds.get("minZ"), minimum[2]],
			[live_bounds.get("maxX"), maximum[0]],
			[live_bounds.get("maxY"), maximum[1]],
			[live_bounds.get("maxZ"), maximum[2]],
		]:
			if not _same_number(pair[0], pair[1]):
				return false

	var live_provenance_variant: Variant = payload.get("provenance")
	var imported_provenance_variant: Variant = loader.manifest.get("provenance")
	if (
		typeof(live_provenance_variant) != TYPE_DICTIONARY
		or typeof(imported_provenance_variant) != TYPE_DICTIONARY
	):
		return false
	var live_provenance: Dictionary = live_provenance_variant
	var imported_provenance: Dictionary = imported_provenance_variant
	for key in PROVENANCE_IDENTITY_FIELDS:
		if not live_provenance.has(key) or not imported_provenance.has(key):
			return false
		if live_provenance.get(key) != imported_provenance.get(key):
			return false
	return _valid_sha256(String(live_provenance.get("configurationHash", "")))


func _same_source_projection(live_coordinate: Dictionary, imported_coordinate: Dictionary) -> bool:
	var live_has_projection := live_coordinate.has("source_projection")
	var imported_has_projection := imported_coordinate.has("source_projection")
	if live_has_projection != imported_has_projection:
		return false
	if not live_has_projection:
		return true
	var live_projection_variant: Variant = live_coordinate.get("source_projection")
	var imported_projection_variant: Variant = imported_coordinate.get("source_projection")
	if (
		typeof(live_projection_variant) != TYPE_DICTIONARY
		or typeof(imported_projection_variant) != TYPE_DICTIONARY
	):
		return false
	var live_projection: Dictionary = live_projection_variant
	var imported_projection: Dictionary = imported_projection_variant
	var required_count := (
		SOURCE_PROJECTION_STRING_FIELDS.size() + SOURCE_PROJECTION_NUMBER_FIELDS.size()
	)
	if live_projection.size() != required_count or imported_projection.size() != required_count:
		return false
	for key in SOURCE_PROJECTION_STRING_FIELDS:
		if (
			not live_projection.has(key)
			or not imported_projection.has(key)
			or typeof(live_projection.get(key)) != TYPE_STRING
			or live_projection.get(key) != imported_projection.get(key)
		):
			return false
	if live_projection.get("type") != "polar_stereographic":
		return false
	for key in SOURCE_PROJECTION_NUMBER_FIELDS:
		if (
			not live_projection.has(key)
			or not imported_projection.has(key)
			or not _same_number(live_projection.get(key), imported_projection.get(key))
		):
			return false
	return true


func _same_number(left: Variant, right: Variant) -> bool:
	if not _finite_number(left) or not _finite_number(right):
		return false
	var a := float(left)
	var b := float(right)
	return absf(a - b) <= 1.0e-9 * maxf(1.0, maxf(absf(a), absf(b)))


func _valid_sha256(value: String) -> bool:
	if value.length() != 64:
		return false
	for character in value:
		if character not in "0123456789abcdef":
			return false
	return true


func _finite_number(value: Variant) -> bool:
	return (typeof(value) == TYPE_FLOAT or typeof(value) == TYPE_INT) and is_finite(float(value))


func _handle_error(context: Dictionary, error: Dictionary) -> void:
	var data: Dictionary = error.get("data", {}) if typeof(error.get("data", {})) == TYPE_DICTIONARY else {}
	var details: Dictionary = (
		data.get("details", {}) if typeof(data.get("details", {})) == TYPE_DICTIONARY else {}
	)
	var reason := String(details.get("reason", ""))
	if reason == "pruned" or reason == "unknown" or reason == "revision_mismatch":
		_require_resync(
			int(details.get("headSequence", next_sequence)),
			"sequence %d is %s; the sidecar requires a full resync" % [next_sequence, reason]
		)
		return
	_fail("live sync %s failed: %s" % [context.get("kind", "request"), _describe_error(error)])


func _apply_or_fetch_tile(delta: Dictionary) -> void:
	var sequence := int(delta.get("sequenceNumber", -1))
	if int(delta.get("datasetRevision", -1)) != dataset_revision:
		_require_resync(
			maxi(next_sequence, sequence + 1),
			"delta revision %s does not match live revision %d"
			% [delta.get("datasetRevision", "missing"), dataset_revision]
		)
		return
	if sequence != next_sequence:
		_require_resync(
			maxi(next_sequence, sequence + 1),
			"expected delta %d but received %d" % [next_sequence, sequence]
		)
		return

	var layer_id := _delta_layer_id(delta)
	if layer_id.is_empty():
		_require_resync(sequence + 1, "delta %d declares no edited layer" % sequence)
		return
	var rocks_variant: Variant = delta.get("rocksReseated")
	if (
		not _finite_number(rocks_variant)
		or float(rocks_variant) < 0.0
		or float(rocks_variant) != floorf(float(rocks_variant))
	):
		_require_resync(sequence + 1, "delta %d has an invalid rocksReseated count" % sequence)
		return
	var previous_rock_transfer := String(delta.get("previousRockTransferSha256", ""))
	var resulting_rock_transfer := String(delta.get("resultingRockTransferSha256", ""))
	if (
		previous_rock_transfer != _baseline_rock_transfer_sha
		or not _valid_sha256(resulting_rock_transfer)
	):
		_require_resync(sequence + 1, "delta %d breaks the bound rock-transfer checksum chain" % sequence)
		return
	if (int(rocks_variant) == 0) != (previous_rock_transfer == resulting_rock_transfer):
		_require_resync(
			sequence + 1,
			"delta %d rock digest transition contradicts its rocksReseated count" % sequence
		)
		return
	if not _verify_layer_checksum(layer_id, String(delta.get("previousChecksum", "")), "height"):
		_require_resync(
			sequence + 1,
			"local height checksum does not match delta %d's previous checksum" % sequence
		)
		return
	if not _verify_layer_checksum(layer_id, String(delta.get("previousMaskChecksum", "")), "semantic"):
		_require_resync(
			sequence + 1,
			"local semantic checksum does not match delta %d's previous checksum" % sequence
		)
		return

	if delta.has("sparse"):
		if not _begin_delta_transaction(layer_id):
			_require_resync(sequence + 1, "could not start an atomic delta transaction")
			return
		last_transport = "sparse"
		var applied: Dictionary = loader.apply_sparse_delta(delta.get("sparse", {}))
		if not bool(applied.get("ok", false)):
			_require_resync(sequence + 1, "sparse height apply failed: %s" % applied.get("error", "unknown"))
			return
		var changed_bounds: Dictionary = applied.get("changed_bounds", {})
		if changed_bounds.is_empty():
			changed_bounds = delta.get("affectedBounds", {}) as Dictionary
		if not _apply_mask(delta, changed_bounds):
			return
		_finish_delta(delta, changed_bounds)
		return

	var request: Dictionary = loader.tile_request_for_bounds(
		layer_id, delta.get("affectedBounds", {}) as Dictionary
	)
	if not bool(request.get("ok", false)):
		_require_resync(sequence + 1, "tile fallback could not be formed: %s" % request.get("error", "unknown"))
		return
	var params: Dictionary = request.get("params", request)
	params.erase("ok")
	params["stride"] = 1
	last_transport = "tile"
	_request("terrain.getTile", params, {"kind": "tile", "delta": delta})


func _finish_tile(payload: Dictionary, delta: Dictionary) -> void:
	var sequence := int(delta.get("sequenceNumber", next_sequence))
	var layer_id := _delta_layer_id(delta)
	if not _begin_delta_transaction(layer_id):
		_require_resync(sequence + 1, "could not start an atomic tile transaction")
		return
	var applied: Dictionary = loader.apply_tile_payload(payload)
	if not bool(applied.get("ok", false)):
		_require_resync(
			sequence + 1,
			"full-tile fallback failed: %s" % applied.get("error", "unknown")
		)
		return
	var changed_bounds: Dictionary = applied.get("changed_bounds", {})
	if changed_bounds.is_empty():
		changed_bounds = delta.get("affectedBounds", {}) as Dictionary
	if not _apply_mask(delta, changed_bounds):
		return
	_finish_delta(delta, changed_bounds)


func _apply_mask(delta: Dictionary, changed_bounds: Dictionary) -> bool:
	var changed := int(delta.get("changedMaskSampleCount", 0))
	if changed == 0:
		return true
	if delta.has("maskSparse") and loader.has_method("apply_mask_sparse"):
		var applied: Dictionary = loader.apply_mask_sparse(delta.get("maskSparse", {}))
		if bool(applied.get("ok", false)):
			return true
		_require_resync(
			int(delta.get("sequenceNumber", next_sequence)) + 1,
			"sparse semantic apply failed: %s" % applied.get("error", "unknown")
		)
		return false
	var request: Dictionary = loader.tile_request_for_bounds(
		_delta_layer_id(delta), delta.get("affectedBounds", {}) as Dictionary
	)
	if not bool(request.get("ok", false)):
		_require_resync(
			int(delta.get("sequenceNumber", next_sequence)) + 1,
			"semantic tile fallback could not be formed: %s" % request.get("error", "unknown")
		)
		return false
	var params: Dictionary = request.get("params", request)
	params.erase("ok")
	params["stride"] = 1
	params["channel"] = "semantic"
	last_transport = "%s+semantic_tile" % last_transport
	_request(
		"terrain.getTile",
		params,
		{"kind": "mask_tile", "delta": delta, "changed_bounds": changed_bounds}
	)
	return false


func _finish_mask_tile(payload: Dictionary, delta: Dictionary, changed_bounds: Dictionary) -> void:
	var applied: Dictionary = loader.apply_mask_tile_payload(payload)
	if not bool(applied.get("ok", false)):
		_require_resync(
			int(delta.get("sequenceNumber", next_sequence)) + 1,
			"semantic tile fallback failed: %s" % applied.get("error", "unknown")
		)
		return
	_finish_delta(delta, changed_bounds)


func _finish_delta(delta: Dictionary, changed_bounds: Variant) -> void:
	var sequence := int(delta.get("sequenceNumber", next_sequence))
	var layer_id := _delta_layer_id(delta)
	var rocks_variant: Variant = delta.get("rocksReseated")
	if (
		not _finite_number(rocks_variant)
		or float(rocks_variant) < 0.0
		or float(rocks_variant) != floorf(float(rocks_variant))
	):
		_require_resync(sequence + 1, "delta %d has an invalid rocksReseated count" % sequence)
		return
	var rocks_reseated := int(rocks_variant)
	if (
		(rocks_reseated == 0)
		!= (
			String(delta.get("previousRockTransferSha256", ""))
			== String(delta.get("resultingRockTransferSha256", ""))
		)
	):
		_require_resync(
			sequence + 1,
			"delta %d rock digest transition contradicts its rocksReseated count" % sequence
		)
		return
	var needs_rock_transfer := rocks_reseated > 0
	if needs_rock_transfer and not loader.has_method("replace_rocks"):
		_require_resync(sequence + 1, "delta %d reseated rocks but the loader cannot replace them" % sequence)
		return
	# Hash the complete proposed in-memory state before touching render or
	# collision resources. A rejected authority result must leave both arrays and
	# the previously rendered scene at the prior checksum.
	if not _verify_layer_checksum(layer_id, String(delta.get("resultingChecksum", "")), "height"):
		_require_resync(sequence + 1, "height checksum diverged after applying delta %d" % sequence)
		return
	if not _verify_layer_checksum(layer_id, String(delta.get("resultingMaskChecksum", "")), "semantic"):
		_require_resync(sequence + 1, "semantic checksum diverged after applying delta %d" % sequence)
		return
	var refresh_bounds: Dictionary = (
		changed_bounds as Dictionary
		if typeof(changed_bounds) == TYPE_DICTIONARY
		else delta.get("affectedBounds", {}) as Dictionary
	)
	var refreshed: Dictionary = loader.refresh_changed_bounds(
		terrain_root,
		layer_id,
		refresh_bounds
	)
	if not bool(refreshed.get("ok", false)):
		_require_resync(sequence + 1, "scene refresh failed: %s" % refreshed.get("error", "unknown"))
		return
	_delta_transaction["sequence"] = sequence
	_delta_transaction["scene_refreshed"] = true
	_delta_transaction["changed_bounds"] = refresh_bounds.duplicate(true)
	_delta_transaction["refresh_result"] = refreshed.duplicate(true)
	if needs_rock_transfer:
		last_rock_refresh = "pending"
		_request(
			"terrain.getRocks",
			{"maxInstances": MAX_ROCK_INSTANCES},
			{"kind": "rocks", "delta": delta}
		)
	else:
		last_rock_refresh = "skipped_unchanged"
		_complete_delta(delta)
		state_changed.emit("current", "sequence %d" % next_sequence)


func _finish_rocks(payload: Dictionary, delta: Dictionary) -> void:
	var sequence := int(delta.get("sequenceNumber", -1))
	var expected_sequence := sequence + 1
	if (
		_delta_transaction.is_empty()
		or int(_delta_transaction.get("sequence", -1)) != sequence
		or int(payload.get("datasetRevision", -1)) != dataset_revision
		or int(payload.get("sequenceNumber", -1)) != expected_sequence
		or String(payload.get("terrainId", "")) != String(loader.manifest.get("terrainId", ""))
		or String(payload.get("seed", "")) != String(loader.manifest.get("seed", ""))
	):
		_require_resync(
			maxi(expected_sequence, int(payload.get("sequenceNumber", expected_sequence))),
			"rock response does not belong to the applied terrain revision and sequence"
		)
		return
	var response_baseline: Dictionary = payload.get("baseline", {}) as Dictionary
	var expected_rock_transfer := String(delta.get("resultingRockTransferSha256", ""))
	if (
		String(response_baseline.get("immutableIdentitySha256", "")) != _baseline_immutable_sha
		or not _valid_sha256(String(response_baseline.get("worldStateSha256", "")))
		or not _baseline_channels_match_local(response_baseline)
		or not _rock_counts_match_baseline(payload, response_baseline, expected_rock_transfer)
	):
		_require_resync(expected_sequence, "rock response baseline identity is invalid")
		return
	if bool(payload.get("truncated", false)):
		_require_resync(
			expected_sequence,
			"rock sync returned %d of %d instances" % [
				int(payload.get("returnedCount", 0)), int(payload.get("totalCount", 0))
			]
		)
		return
	var verified_transfer: Dictionary = {}
	if not _rock_payload_matches_transfer(payload, expected_rock_transfer, verified_transfer):
		_require_resync(expected_sequence, "rock response transfer identity is invalid")
		return
	var replaced: Dictionary = loader.replace_rocks(
		terrain_root, verified_transfer.get("payload", {}) as Dictionary
	)
	if not bool(replaced.get("ok", false)):
		_require_resync(
			expected_sequence, "rock instance refresh failed: %s" % replaced.get("error", "unknown")
		)
		return
	last_rock_refresh = "full"
	_baseline_world_sha = String(response_baseline.get("worldStateSha256", ""))
	_complete_delta(delta)
	state_changed.emit(
		"current",
		"sequence %d · %d rocks refreshed after %s" % [
			next_sequence,
			int(payload.get("returnedCount", 0)),
			String(delta.get("deltaId", "delta")),
		]
	)


func _baseline_channels_match_local(baseline: Dictionary) -> bool:
	if int(baseline.get("schemaVersion", -1)) != 1:
		return false
	var heads_variant: Variant = baseline.get("layers")
	if typeof(heads_variant) != TYPE_ARRAY:
		return false
	var heads: Array = heads_variant
	if heads.size() != loader.layers.size():
		return false
	for layer in loader.layers:
		var layer_id := String(layer.id)
		var expected: Dictionary = {}
		for head_variant in heads:
			if typeof(head_variant) == TYPE_DICTIONARY and String(head_variant.get("layerId", "")) == layer_id:
				expected = head_variant
				break
		if expected.is_empty():
			return false
		if not _verify_layer_checksum(layer_id, String(expected.get("heightSha256", "")), "height"):
			return false
		if not _verify_layer_checksum(layer_id, String(expected.get("semanticSha256", "")), "semantic"):
			return false
		if not _verify_layer_checksum(
			layer_id, String(expected.get("elevationSourceSha256", "")), "elevation_source"
		):
			return false
		if expected.get("disturbanceSha256", null) != null:
			return false
	return true


func _rock_counts_match_baseline(
	payload: Dictionary, baseline: Dictionary, expected_transfer_sha: String
) -> bool:
	var rocks_variant: Variant = baseline.get("rocks")
	if typeof(rocks_variant) != TYPE_DICTIONARY:
		return false
	var rocks: Dictionary = rocks_variant
	return (
		int(rocks.get("totalCount", -1)) == int(payload.get("totalCount", -2))
		and int(rocks.get("physicalCount", -1)) == int(payload.get("physicalCount", -2))
		and _valid_sha256(String(rocks.get("physicsSha256", "")))
		and String(rocks.get("transferSha256", "")) == expected_transfer_sha
	)


func _rock_payload_matches_transfer(
	payload: Dictionary, expected_sha: String, verified_out: Dictionary = {}
) -> bool:
	var verified := _verified_rock_transfer(payload, expected_sha)
	if not bool(verified.get("ok", false)):
		return false
	verified_out["payload"] = verified.get("payload", {})
	return true


func _verified_rock_transfer(payload: Dictionary, expected_sha: String) -> Dictionary:
	if (
		not _valid_sha256(expected_sha)
		or String(payload.get("transferEncoding", "")) != ROCK_TRANSFER_ENCODING
		or String(payload.get("transferSha256", "")) != expected_sha
	):
		return {"ok": false}
	var encoded_variant: Variant = payload.get("transferData")
	if typeof(encoded_variant) != TYPE_STRING:
		return {"ok": false}
	var encoded := String(encoded_variant)
	if encoded.length() > MAX_ROCK_TRANSFER_BASE64_CHARS:
		return {"ok": false}
	var bytes := Marshalls.base64_to_raw(encoded)
	if (
		bytes.size() > MAX_ROCK_TRANSFER_BYTES
		or (bytes.is_empty() and not encoded.is_empty())
		or Marshalls.raw_to_base64(bytes) != encoded
	):
		return {"ok": false}
	var context := HashingContext.new()
	if (
		context.start(HashingContext.HASH_SHA256) != OK
		or context.update(bytes) != OK
		or context.finish().hex_encode() != expected_sha
	):
		return {"ok": false}

	var prefix := ROCK_TRANSFER_DIGEST_PREFIX.to_utf8_buffer()
	var offset := prefix.size() + 1
	if bytes.size() < offset + 4:
		return {"ok": false}
	for index in prefix.size():
		if bytes[index] != prefix[index]:
			return {"ok": false}
	if bytes[prefix.size()] != 0:
		return {"ok": false}
	var count := int(bytes.decode_u32(offset))
	offset += 4
	if count > MAX_ROCK_INSTANCES:
		return {"ok": false}
	# Every record has an id length, ten Float64 values, and one physical byte.
	# Reject impossible counts before allocating the normalized record array.
	if bytes.size() - offset < count * (4 + 10 * 8 + 1):
		return {"ok": false}
	var json_rocks_variant: Variant = payload.get("rocks")
	if typeof(json_rocks_variant) != TYPE_ARRAY:
		return {"ok": false}
	var json_rocks: Array = json_rocks_variant
	if json_rocks.size() != count or int(payload.get("returnedCount", -1)) != count:
		return {"ok": false}

	var normalized_rocks: Array = []
	normalized_rocks.resize(count)
	var previous_id := ""
	for rock_index in count:
		if offset + 4 > bytes.size():
			return {"ok": false}
		var id_length := int(bytes.decode_u32(offset))
		offset += 4
		if id_length < 1 or id_length > MAX_ROCK_ID_BYTES or offset + id_length > bytes.size():
			return {"ok": false}
		var id_bytes := bytes.slice(offset, offset + id_length)
		offset += id_length
		var rock_id := id_bytes.get_string_from_utf8()
		if rock_id.to_utf8_buffer() != id_bytes or (rock_index > 0 and rock_id <= previous_id):
			return {"ok": false}
		previous_id = rock_id
		if offset + 10 * 8 + 1 > bytes.size():
			return {"ok": false}
		var decoded_values: Array = []
		decoded_values.resize(10)
		for value_index in 10:
			var decoded := bytes.decode_double(offset)
			offset += 8
			if not is_finite(decoded):
				return {"ok": false}
			decoded_values[value_index] = decoded
		var physical_byte := int(bytes[offset])
		offset += 1
		if physical_byte != 0 and physical_byte != 1:
			return {"ok": false}
		var physical := physical_byte == 1

		var json_rock_variant: Variant = json_rocks[rock_index]
		if typeof(json_rock_variant) != TYPE_DICTIONARY:
			return {"ok": false}
		var json_rock: Dictionary = json_rock_variant
		if (
			typeof(json_rock.get("id")) != TYPE_STRING
			or String(json_rock.get("id")) != rock_id
			or typeof(json_rock.get("physical")) != TYPE_BOOL
			or bool(json_rock.get("physical")) != physical
		):
			return {"ok": false}
		var position := decoded_values.slice(0, 3)
		var rotation := decoded_values.slice(3, 7)
		var scale := decoded_values.slice(7, 10)
		if (
			not _rock_array_coherent(json_rock.get("position_m"), position)
			or not _rock_array_coherent(json_rock.get("rotation_quaternion"), rotation)
			or not _rock_array_coherent(json_rock.get("scale_m"), scale)
		):
			return {"ok": false}
		var normalized := json_rock.duplicate(true)
		normalized["id"] = rock_id
		normalized["position_m"] = position
		normalized["rotation_quaternion"] = rotation
		normalized["scale_m"] = scale
		normalized["physical"] = physical
		normalized_rocks[rock_index] = normalized
	if offset != bytes.size():
		return {"ok": false}
	var normalized_payload := payload.duplicate(true)
	normalized_payload["rocks"] = normalized_rocks
	return {"ok": true, "payload": normalized_payload}


func _rock_array_coherent(json_variant: Variant, decoded: Array) -> bool:
	if typeof(json_variant) != TYPE_ARRAY or (json_variant as Array).size() != decoded.size():
		return false
	var json_values: Array = json_variant
	for index in decoded.size():
		if not _rock_number_coherent(json_values[index], float(decoded[index])):
			return false
	return true


func _rock_number_coherent(json_variant: Variant, decoded: float) -> bool:
	if not _finite_number(json_variant):
		return false
	var parsed := float(json_variant)
	if parsed == decoded:
		return true
	# Godot's JSON number parser can round a correctly serialized IEEE-754 value
	# by one ULP. This machine-epsilon-relative bound accepts that representation
	# drift but still makes the hash-verified binary value the scene authority.
	return absf(parsed - decoded) <= FLOAT64_RELATIVE_EPSILON * maxf(1.0, absf(decoded))


func _complete_delta(delta: Dictionary) -> void:
	var sequence := int(delta.get("sequenceNumber", next_sequence))
	var refresh_variant: Variant = _delta_transaction.get("refresh_result", {})
	if typeof(refresh_variant) == TYPE_DICTIONARY:
		last_refresh = (refresh_variant as Dictionary).duplicate(true)
	_baseline_rock_transfer_sha = String(delta.get("resultingRockTransferSha256", ""))
	_commit_delta_transaction()
	next_sequence = sequence + 1
	delta_applied.emit(
		sequence,
		String(delta.get("deltaId", "delta-%06d" % sequence)),
		int(delta.get("changedSampleCount", 0))
	)


func _delta_layer_id(delta: Dictionary) -> String:
	if delta.has("sparse"):
		return String((delta.get("sparse", {}) as Dictionary).get("layerId", ""))
	if delta.has("maskSparse"):
		return String((delta.get("maskSparse", {}) as Dictionary).get("layerId", ""))
	var operations: Array = delta.get("operations", [])
	if operations.is_empty() or typeof(operations[0]) != TYPE_DICTIONARY:
		return ""
	return String((operations[0] as Dictionary).get("layerId", ""))


func _verify_layer_checksum(layer_id: String, expected: String, channel: String) -> bool:
	if expected.is_empty():
		return false
	var layer: Variant = null
	for candidate in loader.layers:
		if String(candidate.id) == layer_id:
			layer = candidate
			break
	if layer == null:
		return false
	var bytes := PackedByteArray()
	if channel == "semantic":
		var semantic: Variant = layer.get("semantic")
		if semantic != null:
			bytes = semantic as PackedByteArray
	elif channel == "elevation_source":
		var elevation_source: Variant = layer.get("elevation_source")
		if elevation_source != null:
			bytes = elevation_source as PackedByteArray
	elif channel == "height":
		bytes = (layer.heights as PackedFloat32Array).to_byte_array()
	else:
		return false
	var context := HashingContext.new()
	if context.start(HashingContext.HASH_SHA256) != OK:
		return false
	if context.update(bytes) != OK:
		return false
	return context.finish().hex_encode() == expected


func _begin_delta_transaction(layer_id: String) -> bool:
	if not _delta_transaction.is_empty():
		return false
	var layer: Variant = null
	for candidate in loader.layers:
		if String(candidate.id) == layer_id:
			layer = candidate
			break
	if layer == null:
		return false
	_delta_transaction = {
		"layer": layer,
		"layer_id": layer_id,
		"heights": (layer.heights as PackedFloat32Array).duplicate(),
		"semantic": (layer.semantic as PackedByteArray).duplicate(),
		"scene_refreshed": false,
		"changed_bounds": {},
		"refresh_result": {},
		"previous_last_refresh": last_refresh.duplicate(true),
		"previous_last_rock_refresh": last_rock_refresh,
	}
	return true


func _rollback_delta_transaction() -> void:
	if _delta_transaction.is_empty():
		return
	var transaction := _delta_transaction
	_delta_transaction = {}
	var layer: Variant = transaction.get("layer")
	if layer != null:
		layer.heights = transaction.get("heights") as PackedFloat32Array
		layer.semantic = transaction.get("semantic") as PackedByteArray
	if (
		bool(transaction.get("scene_refreshed", false))
		and loader != null
		and terrain_root != null
		and is_instance_valid(terrain_root)
	):
		var restored: Dictionary = loader.refresh_changed_bounds(
			terrain_root,
			String(transaction.get("layer_id", "")),
			transaction.get("changed_bounds", {}) as Dictionary
		)
		if not bool(restored.get("ok", false)):
			push_error("live delta rollback could not restore the scene: %s" % restored.get("error", "unknown"))
	last_refresh = (transaction.get("previous_last_refresh", {}) as Dictionary).duplicate(true)
	last_rock_refresh = String(transaction.get("previous_last_rock_refresh", "none"))


func _commit_delta_transaction() -> void:
	_delta_transaction.clear()


func _require_resync(head_sequence: int, reason: String) -> void:
	_rollback_delta_transaction()
	active = false
	baseline_verified = false
	last_transport = "full_resync"
	_waiting = false
	_request_elapsed = 0.0
	_pending.clear()
	_queued_delta.clear()
	state_changed.emit("resync", reason)
	resync_required.emit(maxi(0, head_sequence), reason)


func _fail(reason: String) -> void:
	_rollback_delta_transaction()
	active = false
	baseline_verified = false
	_waiting = false
	_request_elapsed = 0.0
	_pending.clear()
	_queued_delta.clear()
	state_changed.emit("error", reason)
	sync_failed.emit(reason)


func _describe_error(error: Dictionary) -> String:
	var data: Variant = error.get("data", null)
	if typeof(data) == TYPE_DICTIONARY and (data as Dictionary).has("code"):
		return "%s: %s" % [(data as Dictionary).get("code", ""), error.get("message", "")]
	return "%s (%s)" % [error.get("message", ""), error.get("code", 0)]
