extends SceneTree
## Full Godot ↔ sidecar integration test (spec §26).
##
## Runs the nine steps the spec asks for, against a live sidecar and real
## Chrono-free Godot physics:
##
##   1. connect to the sidecar        6. confirm elevations agree
##   2. request a seeded terrain      7. apply a terrain delta
##   3. import the result             8. sparse-sync affected chunks in memory
##   4. instantiate terrain+collision 9. confirm the collision updated
##   5. sample known points
##
## Step 9 is the one that matters most: it re-raycasts after an excavation and
## checks the *physics* surface moved, not just the file on disk. A terrain
## editor that updates artifacts but leaves stale collision would drive a rover
## through thin air.
##
## Usage:
##   godot --headless --path godot/example-project --script integration.gd -- \
##         --url ws://127.0.0.1:8768 --config <config.json> --out <result.json>

const SidecarClientScript := preload("res://addons/lunar_terrain/sidecar_client.gd")
const LoaderScript := preload("res://addons/lunar_terrain/lunar_terrain_loader.gd")
const LiveSyncScript := preload("res://addons/lunar_terrain/terrain_live_sync.gd")
# Preloaded so a syntax error in the editor-facing scripts fails this test
# rather than waiting to be found the first time somebody enables the plugin.
const DockScript := preload("res://addons/lunar_terrain/dock.gd")
const PluginScript := preload("res://addons/lunar_terrain/plugin.gd")
const RPC_TIMEOUT_SECONDS := 20.0

var client: RefCounted
var _url := ""
var _config_path := ""
var _out_path := ""
var _steps: Array = []
var _root: Node3D = null
var _loader: RefCounted = null
var _sync: Node = null
var _output_dir := ""


func _initialize() -> void:
	var args := OS.get_cmdline_user_args()
	for i in args.size():
		match args[i]:
			"--url":
				_url = args[i + 1]
			"--config":
				_config_path = args[i + 1]
			"--out":
				_out_path = args[i + 1]

	if _url.is_empty() or _config_path.is_empty() or _out_path.is_empty():
		push_error("usage: --url <ws> --config <file> --out <file>")
		quit(2)
		return

	client = SidecarClientScript.new()
	client.connect_to_sidecar(_url)
	_run()


func _process(_delta: float) -> bool:
	if client:
		client.poll()
	return false


func _step(name: String, passed: bool, detail: Variant = null) -> void:
	_steps.append({"step": name, "passed": passed, "detail": detail})
	print("%s  %s%s" % ["PASS" if passed else "FAIL", name, ("  " + str(detail)) if detail != null else ""])


func _changed_identity_value(value: Variant) -> Variant:
	match typeof(value):
		TYPE_STRING:
			return String(value) + " altered"
		TYPE_INT:
			return int(value) + 1
		TYPE_FLOAT:
			return float(value) + 1.0
		TYPE_ARRAY:
			return []
		TYPE_DICTIONARY:
			return {}
		TYPE_BOOL:
			return not bool(value)
	return null


## Instantiate the editor dock headlessly and confirm it builds its controls.
##
## The plugin itself cannot be enabled outside the editor, but the dock is a
## plain VBoxContainer, so building it here proves the script parses, every
## control is constructed, and the sidecar client wires up.
func _collect_button_labels(node: Node, labels: Array[String]) -> void:
	for child in node.get_children():
		if child is Button:
			var button := child as Button
			labels.append(button.text)
			if not button.accessibility_name.is_empty():
				labels.append(button.accessibility_name)
		_collect_button_labels(child, labels)


func _has_button_action(labels: Array[String], required: String) -> bool:
	for label in labels:
		if label.to_lower() == required.to_lower():
			return true
	return false


func _find_text(node: Node, fragment: String) -> bool:
	if node is Label and fragment in (node as Label).text:
		return true
	for child in node.get_children():
		if _find_text(child, fragment):
			return true
	return false


func _check_dock() -> void:
	var dock: Node = DockScript.new()
	var built := dock != null and dock.get_child_count() > 0
	_step("editor dock builds", built, "%d controls" % (dock.get_child_count() if dock else 0))

	# The controls the spec requires the dock to expose.
	var has_client: bool = dock != null and dock.client != null
	_step("dock wires a sidecar client", has_client,
		dock.client.get_class() if has_client else "none")

	var labels: Array[String] = []
	_collect_button_labels(dock, labels)
	var required := [
		"Connect",
		"Open Sidecar UI",
		"Generate",
		"Regenerate",
		"Import",
		"Inspect Point",
		"Compute Horizon",
		"Apply Simulated Terrain Edit",
	]
	var missing: Array[String] = []
	for r in required:
		if not _has_button_action(labels, r):
			missing.append(r)
	_step("dock exposes the required actions", missing.is_empty(),
		"missing %s" % str(missing) if not missing.is_empty() else str(labels))
	_step(
		"dock labels simulation authority",
		_find_text(dock, "NOT A LIVE COMMAND INTERFACE"),
		"simulation boundary is explicit text"
	)
	_step(
		"dock content is scrollable",
		dock.get_node_or_null("DockScroll") is ScrollContainer,
		"native ScrollContainer"
	)
	var maximum_raw_height_bytes := LoaderScript.MAX_SAMPLES_PER_LAYER * 4
	var maximum_base64_height_bytes := ceili(float(maximum_raw_height_bytes) / 3.0) * 4
	_step(
		"WebSocket bound carries the largest accepted height tile",
		SidecarClientScript.MAX_INBOUND_BYTES >= maximum_base64_height_bytes + 1024 * 1024,
		"%d MiB buffer · %.1f MiB maximum base64 payload"
		% [
			SidecarClientScript.MAX_INBOUND_BYTES / (1024 * 1024),
			float(maximum_base64_height_bytes) / float(1024 * 1024),
		]
	)

	if dock:
		dock.free()

	# Explicit close is a separate path from a peer drop. It must announce the
	# transition exactly once so the editor dock can disable construction/live
	# sync immediately instead of waiting for a socket state it will never see.
	var close_probe: RefCounted = SidecarClientScript.new()
	var disconnect_events := {"count": 0}
	close_probe.sidecar_disconnected.connect(
		func() -> void: disconnect_events["count"] = int(disconnect_events["count"]) + 1
	)
	close_probe.state = SidecarClientScript.State.CONNECTED
	close_probe.close()
	close_probe.close()
	_step(
		"explicit client close emits one disconnect",
		int(disconnect_events["count"]) == 1
			and close_probe.state == SidecarClientScript.State.DISCONNECTED,
		"%d events" % int(disconnect_events["count"])
	)

	# A socket can fail between a state check and send_text(). The request must
	# not be recorded as in flight when no bytes entered the transport.
	var send_probe: RefCounted = SidecarClientScript.new()
	send_probe.state = SidecarClientScript.State.CONNECTED
	var failed_send_id: int = send_probe.call_method("terrain.health")
	_step(
		"client rejects a request when the socket send fails",
		failed_send_id == -1
			and send_probe._inflight.is_empty()
			and not send_probe.last_error.is_empty(),
		send_probe.last_error
	)


## Issue a request and await its response with a real wall-clock deadline.
## Returns {result, error}; a silent peer cannot hang the acceptance run.
func _rpc(method: String, params: Dictionary = {}) -> Dictionary:
	var id: int = client.call_method(method, params)
	if id < 0:
		return {"result": null, "error": {"message": client.last_error}}
	var reply: Dictionary = {}
	var receive := func(response_id: int, result: Variant, error: Dictionary) -> void:
		if response_id == id:
			reply["result"] = result
			reply["error"] = error
	client.response.connect(receive)
	var waited := 0.0
	while reply.is_empty() and waited < RPC_TIMEOUT_SECONDS:
		await create_timer(0.05).timeout
		waited += 0.05
	if client.response.is_connected(receive):
		client.response.disconnect(receive)
	if reply.is_empty():
		return {
			"result": null,
			"error": {
				"code": -32098,
				"message": "%s timed out after %.1f seconds" % [method, RPC_TIMEOUT_SECONDS],
			},
		}
	return reply


func _await_sync(next_expected_sequence: int, timeout_seconds: float = 30.0) -> bool:
	var waited := 0.0
	while waited < timeout_seconds:
		if _sync.has_applied_through(next_expected_sequence):
			return true
		if not _sync.active:
			return false
		await create_timer(0.05).timeout
		waited += 0.05
	return false


func _finish(ok: bool, reason: String = "") -> void:
	var report := {
		"ok": ok,
		"reason": reason,
		"steps": _steps,
		"passed": _steps.filter(func(s): return s["passed"]).size(),
		"total": _steps.size(),
		"godot_version": Engine.get_version_info(),
	}
	var f := FileAccess.open(_out_path, FileAccess.WRITE)
	if f != null:
		f.store_string(JSON.stringify(report, "  "))
		f.close()
	quit(0 if ok else 1)


func _run() -> void:
	# --- 0. the editor dock must load and build its UI ------------------------
	_check_dock()

	# --- 1. connect -----------------------------------------------------------
	var waited := 0.0
	while not client.is_connected_to_sidecar() and waited < 15.0:
		await create_timer(0.1).timeout
		waited += 0.1
	if not client.is_connected_to_sidecar():
		_step("connect to sidecar", false, client.last_error)
		_finish(false, "could not connect")
		return
	_step("connect to sidecar", true, client.protocol_version)

	var health := await _rpc("terrain.health")
	_step("terrain.health", health["error"].is_empty(), health["result"])

	# --- 2. request a seeded terrain -----------------------------------------
	var cfg_text := FileAccess.get_file_as_string(_config_path)
	var cfg: Variant = JSON.parse_string(cfg_text)
	if typeof(cfg) != TYPE_DICTIONARY:
		_step("read configuration", false, _config_path)
		_finish(false, "bad configuration")
		return
	_output_dir = String((cfg as Dictionary).get("outputDirectory", ""))

	var gen := await _rpc("terrain.generate", {"config": cfg})
	if not gen["error"].is_empty():
		_step("terrain.generate", false, gen["error"])
		_finish(false, "generate failed")
		return
	var job_id := String((gen["result"] as Dictionary).get("jobId", ""))
	_step("terrain.generate accepted", not job_id.is_empty(), job_id)

	var status := {}
	for _i in range(3000):
		await create_timer(0.1).timeout
		var s := await _rpc("terrain.getStatus", {"jobId": job_id})
		status = s["result"] if s["error"].is_empty() else {}
		var st := String(status.get("status", ""))
		if st == "complete" or st == "failed" or st == "cancelled":
			break
	if String(status.get("status", "")) != "complete":
		_step("generation completes", false, status)
		_finish(false, "generation did not complete")
		return
	_step("generation completes", true, status.get("outputDirectory", ""))
	_output_dir = String(status.get("outputDirectory", _output_dir))

	# Exercise the two generation-chain send failures with the real completed-job
	# status above and a real WebSocketPeer that reports CONNECTED just before its
	# underlying send fails. Neither failure may strand the editor in a busy state.
	var dock_send_probe: Node = DockScript.new()
	root.add_child(dock_send_probe)
	dock_send_probe.client.state = SidecarClientScript.State.CONNECTED
	dock_send_probe._current_job = job_id
	dock_send_probe._generate_button.disabled = true
	dock_send_probe._regenerate_button.disabled = true
	dock_send_probe._poll_status()
	_step(
		"dock recovers when status send fails",
		dock_send_probe._current_job.is_empty()
			and not dock_send_probe._generate_button.disabled
			and not dock_send_probe._regenerate_button.disabled
			and dock_send_probe._stage_label.text == "idle",
		"job %s · stage %s" % [dock_send_probe._current_job, dock_send_probe._stage_label.text]
	)
	dock_send_probe.client.state = SidecarClientScript.State.CONNECTED
	dock_send_probe._current_job = job_id
	dock_send_probe._generate_button.disabled = true
	dock_send_probe._regenerate_button.disabled = true
	dock_send_probe._handle_status(status)
	_step(
		"dock recovers when chained export send fails",
		dock_send_probe._current_job.is_empty()
			and not dock_send_probe._generate_button.disabled
			and not dock_send_probe._regenerate_button.disabled
			and dock_send_probe._stage_label.text == "idle",
		"job %s · stage %s" % [dock_send_probe._current_job, dock_send_probe._stage_label.text]
	)
	dock_send_probe.free()

	# --- 3 & 4. import, instantiate terrain and collision ---------------------
	_loader = LoaderScript.new()
	if not _loader.load_export(_output_dir):
		_step("import export", false, _loader.errors)
		_finish(false, "import failed")
		return
	_step("import export", true, "%d layers" % _loader.layers.size())

	_root = _loader.build_scene(root)
	var collision := _root.get_node("TerrainCollision")
	_step("instantiate terrain + collision", collision.get_child_count() > 0,
		"%d collision regions" % collision.get_child_count())
	_sync = LiveSyncScript.new()
	_root.add_child(_sync)
	_sync.configure(client, _loader, _root, 0)
	_sync.start()
	var baseline_ready := await _await_sync(0)
	_step(
		"live baseline checksum handshake",
		baseline_ready,
		"revision %d · sequence %d" % [_sync.dataset_revision, _sync.next_sequence]
	)
	if not baseline_ready:
		_finish(false, "imported terrain did not match the live sidecar baseline")
		return

	# Prove the handshake rejects metadata/configuration drift even when a
	# caller presents otherwise valid dictionaries, and that rock responses are
	# bound to the installed revision + sequence rather than accepted by shape.
	var identity_rpc := await _rpc("terrain.getDataset")
	var identity_payload: Dictionary = (
		identity_rpc["result"] as Dictionary if identity_rpc["error"].is_empty() else {}
	)
	_step(
		"live baseline binds immutable dataset identity",
		not identity_payload.is_empty()
			and bool(_sync.call("_verify_dataset_identity", identity_payload)),
		"geometry, origin, frame, provenance, and configuration hash"
	)
	var coordinate_changes := {
		"handedness": "left",
		"up_axis": "-Y",
		"east_axis": "-X",
		"north_axis": "+Z",
		"south_axis": "-Z",
		"linear_unit": "kilometer",
		"angular_unit": "radian",
		"note": String(
			(identity_payload.get("coordinateSystem", {}) as Dictionary).get("note", "")
		) + " altered",
		"body_frame": "MOON_PA",
		"body_radius_m": float(
			(identity_payload.get("coordinateSystem", {}) as Dictionary).get("body_radius_m", 0.0)
		) + 1.0,
	}
	var rejected_coordinate_mutations := 0
	for coordinate_key in coordinate_changes:
		var missing_coordinate := identity_payload.duplicate(true)
		(missing_coordinate.get("coordinateSystem", {}) as Dictionary).erase(coordinate_key)
		if not bool(_sync.call("_verify_dataset_identity", missing_coordinate)):
			rejected_coordinate_mutations += 1
		var changed_coordinate := identity_payload.duplicate(true)
		(changed_coordinate.get("coordinateSystem", {}) as Dictionary)[coordinate_key] = (
			coordinate_changes[coordinate_key]
		)
		if not bool(_sync.call("_verify_dataset_identity", changed_coordinate)):
			rejected_coordinate_mutations += 1
	_step(
		"live identity requires every coordinate field",
		rejected_coordinate_mutations == coordinate_changes.size() * 2,
		"%d/%d missing-or-changed fields rejected"
		% [rejected_coordinate_mutations, coordinate_changes.size() * 2]
	)

	var rejected_local_origin_mutations := 0
	for axis in ["x", "y", "z"]:
		var missing_local := identity_payload.duplicate(true)
		var missing_origin: Dictionary = missing_local.get("origin", {})
		(missing_origin.get("local", {}) as Dictionary).erase(axis)
		if not bool(_sync.call("_verify_dataset_identity", missing_local)):
			rejected_local_origin_mutations += 1
		var changed_local := identity_payload.duplicate(true)
		var changed_origin: Dictionary = changed_local.get("origin", {})
		var changed_values: Dictionary = changed_origin.get("local", {})
		changed_values[axis] = float(changed_values.get(axis, 0.0)) + 1.0
		if not bool(_sync.call("_verify_dataset_identity", changed_local)):
			rejected_local_origin_mutations += 1
	_step(
		"live identity binds the local origin",
		rejected_local_origin_mutations == 6,
		"%d/6 missing-or-changed axes rejected" % rejected_local_origin_mutations
	)

	# Exercise the source_projection emitted from the real Site01 GeoTIFF.
	# Presence must agree on both sides and every field is load-bearing.
	var original_imported_coordinate: Dictionary = _loader.manifest.get(
		"coordinate_system", {}
	)
	var source_projection: Dictionary = (
		(identity_payload.get("coordinateSystem", {}) as Dictionary).get(
			"source_projection", {}
		) as Dictionary
	)
	var matching_projection_accepted := bool(
		_sync.call("_verify_dataset_identity", identity_payload)
	)
	var rejected_projection_mutations := 0
	for projection_key in source_projection:
		var missing_projection_field := identity_payload.duplicate(true)
		var missing_projection: Dictionary = (
			(missing_projection_field.get("coordinateSystem", {}) as Dictionary).get(
				"source_projection", {}
			)
		)
		missing_projection.erase(projection_key)
		if not bool(_sync.call("_verify_dataset_identity", missing_projection_field)):
			rejected_projection_mutations += 1
		var changed_projection_field := identity_payload.duplicate(true)
		var changed_projection: Dictionary = (
			(changed_projection_field.get("coordinateSystem", {}) as Dictionary).get(
				"source_projection", {}
			)
		)
		changed_projection[projection_key] = _changed_identity_value(
			changed_projection.get(projection_key)
		)
		if not bool(_sync.call("_verify_dataset_identity", changed_projection_field)):
			rejected_projection_mutations += 1
	var missing_live_projection := identity_payload.duplicate(true)
	(missing_live_projection.get("coordinateSystem", {}) as Dictionary).erase(
		"source_projection"
	)
	var missing_live_projection_rejected := not bool(
		_sync.call("_verify_dataset_identity", missing_live_projection)
	)
	var imported_without_projection := original_imported_coordinate.duplicate(true)
	imported_without_projection.erase("source_projection")
	_loader.manifest["coordinate_system"] = imported_without_projection
	var missing_imported_projection_rejected := not bool(
		_sync.call("_verify_dataset_identity", identity_payload)
	)
	_loader.manifest["coordinate_system"] = original_imported_coordinate
	_step(
		"live identity binds source projection",
		matching_projection_accepted
			and missing_live_projection_rejected
			and missing_imported_projection_rejected
			and rejected_projection_mutations == source_projection.size() * 2,
		"matching %s · one-sided live/import %s/%s · %d/%d field mutations rejected"
		% [
			matching_projection_accepted,
			missing_live_projection_rejected,
			missing_imported_projection_rejected,
			rejected_projection_mutations,
			source_projection.size() * 2,
		]
	)

	var provenance_fields := [
		"generator",
		"seeds",
		"dataSources",
		"literatureModels",
		"syntheticHeuristics",
		"limitations",
		"configurationHash",
	]
	var rejected_provenance_mutations := 0
	for provenance_key in provenance_fields:
		var missing_provenance := identity_payload.duplicate(true)
		(missing_provenance.get("provenance", {}) as Dictionary).erase(provenance_key)
		if not bool(_sync.call("_verify_dataset_identity", missing_provenance)):
			rejected_provenance_mutations += 1
		var changed_provenance := identity_payload.duplicate(true)
		var changed_provenance_values: Dictionary = changed_provenance.get("provenance", {})
		changed_provenance_values[provenance_key] = _changed_identity_value(
			changed_provenance_values.get(provenance_key)
		)
		if not bool(_sync.call("_verify_dataset_identity", changed_provenance)):
			rejected_provenance_mutations += 1
	_step(
		"live identity binds provenance",
		rejected_provenance_mutations == provenance_fields.size() * 2,
		"%d/%d missing-or-changed fields rejected"
		% [rejected_provenance_mutations, provenance_fields.size() * 2]
	)

	var live_provenance: Dictionary = identity_payload.get("provenance", {})
	var live_sources: Array = live_provenance.get("dataSources", [])
	var rejected_source_mutations := 0
	var tested_source_fields := 0
	if not live_sources.is_empty():
		var real_source: Dictionary = live_sources[0]
		for source_key in real_source:
			tested_source_fields += 1
			var missing_source_field := identity_payload.duplicate(true)
			var missing_sources: Array = (
				(missing_source_field.get("provenance", {}) as Dictionary).get("dataSources", [])
			)
			(missing_sources[0] as Dictionary).erase(source_key)
			if not bool(_sync.call("_verify_dataset_identity", missing_source_field)):
				rejected_source_mutations += 1
			var changed_source_field := identity_payload.duplicate(true)
			var changed_sources: Array = (
				(changed_source_field.get("provenance", {}) as Dictionary).get("dataSources", [])
			)
			(changed_sources[0] as Dictionary)[source_key] = _changed_identity_value(
				(changed_sources[0] as Dictionary).get(source_key)
			)
			if not bool(_sync.call("_verify_dataset_identity", changed_source_field)):
				rejected_source_mutations += 1
	_step(
		"live identity binds the real DEM source",
		tested_source_fields > 0 and rejected_source_mutations == tested_source_fields * 2,
		"%d/%d Site01 source-field mutations rejected"
		% [rejected_source_mutations, tested_source_fields * 2]
	)
	var shifted_identity := identity_payload.duplicate(true)
	if not shifted_identity.is_empty():
		var shifted_layers: Array = shifted_identity.get("layers", [])
		if not shifted_layers.is_empty():
			var shifted_bounds: Dictionary = (shifted_layers[0] as Dictionary).get("bounds", {})
			shifted_bounds["minX"] = float(shifted_bounds.get("minX", 0.0)) + 1.0
	_step(
		"live baseline rejects shifted geometry",
		not shifted_identity.is_empty()
			and not bool(_sync.call("_verify_dataset_identity", shifted_identity)),
		"same terrain label cannot authorize a shifted layer"
	)
	var rock_rpc := await _rpc("terrain.getRocks", {"maxInstances": 50_000})
	var rock_payload: Dictionary = (
		rock_rpc["result"] as Dictionary if rock_rpc["error"].is_empty() else {}
	)
	var stale_rocks := rock_payload.duplicate(true)
	var future_rocks := rock_payload.duplicate(true)
	if not stale_rocks.is_empty():
		stale_rocks["datasetRevision"] = _sync.dataset_revision + 1
		future_rocks["sequenceNumber"] = _sync.next_sequence + 1
	_step(
		"rock physics response is revision-and-sequence-bound",
		not rock_payload.is_empty()
			and bool(_sync.call("_rock_response_matches_baseline", rock_payload))
			and not bool(_sync.call("_rock_response_matches_baseline", stale_rocks))
			and not bool(_sync.call("_rock_response_matches_baseline", future_rocks)),
		"revision %d · sequence %d" % [_sync.dataset_revision, _sync.next_sequence]
	)
	var duplicate_rock_ids := rock_payload.duplicate(true)
	var duplicate_rocks: Array = duplicate_rock_ids.get("rocks", [])
	if duplicate_rocks.size() >= 2:
		(duplicate_rocks[1] as Dictionary)["id"] = (duplicate_rocks[0] as Dictionary).get(
			"id", ""
		)
	var out_of_order_rocks := rock_payload.duplicate(true)
	var reordered: Array = out_of_order_rocks.get("rocks", [])
	if reordered.size() >= 2:
		var first_rock: Variant = reordered[0]
		reordered[0] = reordered[1]
		reordered[1] = first_rock
	var corrupt_transfer := rock_payload.duplicate(true)
	var transfer_data := String(corrupt_transfer.get("transferData", ""))
	if not transfer_data.is_empty():
		corrupt_transfer["transferData"] = (
			("B" if transfer_data.begins_with("A") else "A") + transfer_data.substr(1)
		)
	var expected_rock_transfer := String(
		(rock_payload.get("baseline", {}) as Dictionary).get("rocks", {}).get(
			"transferSha256", ""
		)
	)
	var duplicate_rejected := not bool(
		_sync.call("_rock_payload_matches_transfer", duplicate_rock_ids, expected_rock_transfer)
	)
	var order_rejected := not bool(
		_sync.call("_rock_payload_matches_transfer", out_of_order_rocks, expected_rock_transfer)
	)
	var bytes_rejected := not bool(
		_sync.call("_rock_payload_matches_transfer", corrupt_transfer, expected_rock_transfer)
	)
	_step(
		"rock transfer rejects corrupt bytes and invalid ordering",
		duplicate_rocks.size() >= 2
			and duplicate_rejected
			and order_rejected
			and bytes_rejected,
		"duplicate %s · order %s · bytes %s"
		% [duplicate_rejected, order_rejected, bytes_rejected]
	)

	# The coordinate contract must survive the round trip.
	var cs: Dictionary = _loader.manifest.get("coordinate_system", {})
	_step("coordinate contract preserved",
		cs.get("handedness", "") == "right" and cs.get("north_axis", "") == "-Z",
		cs)

	# Let physics register the static bodies.
	await physics_frame
	await physics_frame

	# --- 5 & 6. sample known points, confirm agreement -----------------------
	var finest = _loader.layers[0]
	for layer in _loader.layers:
		if layer.resolution_m < finest.resolution_m:
			finest = layer
	var space := _root.get_world_3d().direct_space_state

	var max_err := 0.0
	var probes := 0
	var misses := 0
	for i in range(12):
		# Interior grid samples, nudged off the vertex so the ray does not run
		# down the shared edge of two triangles.
		var fc := 0.2 + 0.6 * (float(i % 4) / 3.0)
		var fr := 0.2 + 0.6 * (float(i / 4) / 2.0)
		var col := int(fc * float(finest.width_samples - 1))
		var row := int(fr * float(finest.height_samples - 1))
		var x: float = finest.min_x + (float(col) + 0.001) * finest.resolution_m
		var z: float = finest.min_z + (float(row) + 0.001) * finest.resolution_m

		var sidecar := await _rpc("terrain.getHeight", {"x": x, "z": z})
		if not sidecar["error"].is_empty():
			continue
		var expected := float((sidecar["result"] as Dictionary).get("elevationM", 0.0))

		var q := PhysicsRayQueryParameters3D.create(
			Vector3(x, expected + 50.0, z), Vector3(x, expected - 50.0, z)
		)
		var hit := space.intersect_ray(q)
		probes += 1
		if hit.is_empty():
			misses += 1
			continue
		max_err = maxf(max_err, absf(float((hit["position"] as Vector3).y) - expected))

	_step("sample known points", probes >= 10, "%d probes, %d missed" % [probes, misses])
	_step("elevation agrees with the sidecar", misses == 0 and max_err < 0.01,
		"max error %.6f m" % max_err)

	# --- 7. apply a terrain delta --------------------------------------------
	var edit_x: float = finest.min_x + float(finest.width_samples - 1) * finest.resolution_m * 0.5
	var edit_z: float = finest.min_z + float(finest.height_samples - 1) * finest.resolution_m * 0.5
	# HeightMapShape3D rays exactly through a shared triangle vertex are
	# degenerate. Probe one thousandth of a cell off that vertex, matching the
	# documented round-trip collision test, while keeping the edit centred on the
	# exact sample.
	var collision_probe_x: float = edit_x + 0.001 * finest.resolution_m
	var collision_probe_z: float = edit_z + 0.001 * finest.resolution_m

	var before_rpc := await _rpc(
		"terrain.getHeight", {"x": collision_probe_x, "z": collision_probe_z}
	)
	if not before_rpc["error"].is_empty() or typeof(before_rpc["result"]) != TYPE_DICTIONARY:
		_step("read pre-edit sidecar height", false, before_rpc["error"])
		_finish(false, "pre-edit height request failed")
		return
	var before_h := float((before_rpc["result"] as Dictionary).get("elevationM", 0.0))

	# Raycast the collision *before* the edit, so step 9 has a baseline.
	var q0 := PhysicsRayQueryParameters3D.create(
		Vector3(collision_probe_x, before_h + 50.0, collision_probe_z),
		Vector3(collision_probe_x, before_h - 50.0, collision_probe_z)
	)
	var hit0 := space.intersect_ray(q0)
	var collision_before: float = float((hit0["position"] as Vector3).y) if not hit0.is_empty() else NAN

	# Hold the periodic poll while this test obtains and fault-injects the same
	# authoritative delta explicitly. Otherwise a 0.5 s poll can win the race and
	# apply it before the atomicity probes run, making their pre-state nondeterministic.
	_sync.active = false
	var depth := 0.4
	var delta := await _rpc("terrain.applyOperation", {
		"operation": {
			"kind": "lower",
			"layerId": finest.id,
			"centerXMeters": edit_x,
			"centerZMeters": edit_z,
			"radiusMeters": maxf(1.0, finest.resolution_m * 20.0),
			"strengthMeters": depth,
			"falloff": 2.0,
			"massConserving": true,
		}
	})
	if not delta["error"].is_empty():
		_step("apply terrain delta", false, delta["error"])
		_finish(false, "applyOperation failed")
		return

	var d: Dictionary = (delta["result"] as Dictionary).get("delta", {})
	var changed_tiles: Array = d.get("changedTiles", [])
	var mass: Dictionary = d.get("massBalance", {})
	_step("apply terrain delta", changed_tiles.size() > 0,
		"%s, %d tiles changed" % [d.get("deltaId", ""), changed_tiles.size()])
	_step("delta is checksum-chained",
		String(d.get("previousChecksum", "")) != String(d.get("resultingChecksum", "")),
		"%s -> %s" % [String(d.get("previousChecksum", "")).substr(0, 8),
			String(d.get("resultingChecksum", "")).substr(0, 8)])
	_step("cut and fill balance",
		float(mass.get("relativeError", 1.0)) < 0.01,
		"cut %.4f m3, fill %.4f m3, error %.3f%%" % [
			float(mass.get("removedVolumeM3", 0.0)),
			float(mass.get("depositedVolumeM3", 0.0)),
			float(mass.get("relativeError", 1.0)) * 100.0])
	var post_delta_rocks_rpc := await _rpc("terrain.getRocks", {"maxInstances": 50_000})
	var post_delta_rocks: Dictionary = (
		post_delta_rocks_rpc["result"] as Dictionary
		if post_delta_rocks_rpc["error"].is_empty()
		else {}
	)

	# A delta is one atomic local transaction. Derive rejected payloads from
	# the real lower-operation delta above and prove a later semantic/checksum
	# failure cannot leave its already-applied height bytes behind. Manual restore
	# below is test cleanup for the intentionally failing pre-fix run only.
	var before_fault_heights: PackedFloat32Array = finest.heights.duplicate()
	var before_fault_semantic: PackedByteArray = finest.semantic.duplicate()
	var sequence_before_fault: int = _sync.next_sequence

	var invalid_mask_delta := d.duplicate(true)
	invalid_mask_delta["changedMaskSampleCount"] = 1
	invalid_mask_delta["maskSparse"] = {
		"layerId": finest.id,
		"sampleCount": 1,
		"indices": "not-canonical-base64",
		"values": "AA==",
	}
	_sync.last_refresh = {"transaction_probe": "untouched"}
	_sync.call("_apply_or_fetch_tile", invalid_mask_delta)
	var semantic_apply_rolled_back: bool = (
		bool(_sync.call("_verify_layer_checksum", finest.id, d.get("previousChecksum", ""), "height"))
		and bool(
			_sync.call(
				"_verify_layer_checksum", finest.id, d.get("previousMaskChecksum", ""), "semantic"
			)
		)
		and _sync.next_sequence == sequence_before_fault
		and _sync.last_refresh.get("transaction_probe", "") == "untouched"
	)
	_step(
		"semantic apply failure rolls back the height transaction",
		semantic_apply_rolled_back,
		"height/mask restored %s · sequence %d" % [semantic_apply_rolled_back, _sync.next_sequence]
	)
	finest.heights = before_fault_heights.duplicate()
	finest.semantic = before_fault_semantic.duplicate()
	_sync.active = false
	_sync.baseline_verified = true
	_sync.last_transport = "none"

	var invalid_mask_fetch_delta := d.duplicate(true)
	invalid_mask_fetch_delta["changedMaskSampleCount"] = 1
	invalid_mask_fetch_delta.erase("maskSparse")
	var live_sync_client: RefCounted = _sync.client
	var failed_fetch_client: RefCounted = SidecarClientScript.new()
	failed_fetch_client.state = SidecarClientScript.State.CONNECTED
	_sync.client = failed_fetch_client
	_sync.last_refresh = {"transaction_probe": "untouched"}
	_sync.call("_apply_or_fetch_tile", invalid_mask_fetch_delta)
	_sync.client = live_sync_client
	var semantic_fetch_rolled_back: bool = (
		bool(_sync.call("_verify_layer_checksum", finest.id, d.get("previousChecksum", ""), "height"))
		and bool(
			_sync.call(
				"_verify_layer_checksum", finest.id, d.get("previousMaskChecksum", ""), "semantic"
			)
		)
		and _sync.next_sequence == sequence_before_fault
		and _sync.last_refresh.get("transaction_probe", "") == "untouched"
	)
	_step(
		"semantic fetch failure rolls back the height transaction",
		semantic_fetch_rolled_back,
		"height/mask restored %s · sequence %d" % [semantic_fetch_rolled_back, _sync.next_sequence]
	)
	finest.heights = before_fault_heights.duplicate()
	finest.semantic = before_fault_semantic.duplicate()
	_sync.active = false
	_sync.baseline_verified = true
	_sync.last_transport = "none"

	var invalid_result_delta := d.duplicate(true)
	invalid_result_delta["resultingChecksum"] = "0".repeat(64)
	_sync.last_refresh = {"transaction_probe": "untouched"}
	_sync.call("_apply_or_fetch_tile", invalid_result_delta)
	await physics_frame
	await physics_frame
	var fault_hit := _root.get_world_3d().direct_space_state.intersect_ray(q0)
	var fault_collision_y: float = (
		float((fault_hit.get("position", Vector3(NAN, NAN, NAN)) as Vector3).y)
		if not fault_hit.is_empty()
		else NAN
	)
	var result_checksum_rolled_back: bool = (
		bool(_sync.call("_verify_layer_checksum", finest.id, d.get("previousChecksum", ""), "height"))
		and bool(
			_sync.call(
				"_verify_layer_checksum", finest.id, d.get("previousMaskChecksum", ""), "semantic"
			)
		)
		and _sync.next_sequence == sequence_before_fault
		and _sync.last_refresh.get("transaction_probe", "") == "untouched"
		and not is_nan(fault_collision_y)
		and absf(fault_collision_y - collision_before) < 0.01
	)
	_step(
		"result checksum failure rolls back before scene refresh",
		result_checksum_rolled_back,
		"height/mask restored %s · collision %.6f -> %.6f"
		% [result_checksum_rolled_back, collision_before, fault_collision_y]
	)
	finest.heights = before_fault_heights.duplicate()
	finest.semantic = before_fault_semantic.duplicate()
	_loader.refresh_changed_bounds(_root, finest.id, d.get("affectedBounds", {}) as Dictionary)
	await physics_frame
	await physics_frame
	_sync.active = false
	_sync.baseline_verified = true
	_sync.last_transport = "none"

	var invalid_rock_response := post_delta_rocks.duplicate(true)
	var invalid_rocks: Array = invalid_rock_response.get("rocks", [])
	if not invalid_rocks.is_empty():
		var invalid_position: Array = (invalid_rocks[0] as Dictionary).get("position_m", []).duplicate()
		if invalid_position.size() == 3:
			# Keep the response structurally valid and safely below the real surface;
			# only its exact authoritative transform identity is corrupted.
			invalid_position[1] = float(invalid_position[1]) - 0.01
			(invalid_rocks[0] as Dictionary)["position_m"] = invalid_position
	_sync.last_refresh = {"transaction_probe": "untouched"}
	_sync.call("_apply_or_fetch_tile", d)
	# Mirror _on_response's request-lane cleanup before injecting the corrupted
	# real response; the actual socket reply is then ignored by request id.
	_sync._pending.clear()
	_sync._waiting = false
	_sync.call("_finish_rocks", invalid_rock_response, d)
	await physics_frame
	await physics_frame
	var rock_fault_hit := _root.get_world_3d().direct_space_state.intersect_ray(q0)
	var rock_fault_collision_y: float = (
		float((rock_fault_hit.get("position", Vector3(NAN, NAN, NAN)) as Vector3).y)
		if not rock_fault_hit.is_empty()
		else NAN
	)
	var rock_failure_rolled_back: bool = (
		int(d.get("rocksReseated", 0)) > 0
		and not post_delta_rocks.is_empty()
		and bool(_sync.call("_verify_layer_checksum", finest.id, d.get("previousChecksum", ""), "height"))
		and bool(
			_sync.call(
				"_verify_layer_checksum", finest.id, d.get("previousMaskChecksum", ""), "semantic"
			)
		)
		and _sync.next_sequence == sequence_before_fault
		and _sync.last_refresh.get("transaction_probe", "") == "untouched"
		and not is_nan(rock_fault_collision_y)
		and absf(rock_fault_collision_y - collision_before) < 0.01
	)
	_step(
		"rock transform corruption rolls back terrain before commit",
		rock_failure_rolled_back,
		"reseated %d · restored %s · collision %.6f -> %.6f"
		% [
			int(d.get("rocksReseated", 0)),
			rock_failure_rolled_back,
			collision_before,
			rock_fault_collision_y,
		]
	)
	finest.heights = before_fault_heights.duplicate()
	finest.semantic = before_fault_semantic.duplicate()
	_loader.refresh_changed_bounds(_root, finest.id, d.get("affectedBounds", {}) as Dictionary)
	_loader.replace_rocks(_root, rock_payload)
	await physics_frame
	await physics_frame
	_sync.next_sequence = sequence_before_fault
	_sync.active = true
	_sync.baseline_verified = true
	_sync.last_transport = "none"

	# --- 8. consume the sparse payload and rebuild intersecting chunks only ----
	_sync.accept_delta(d)
	var sync_complete := await _await_sync(int(d.get("sequenceNumber", 0)) + 1)
	_step(
		"sparse delta syncs without re-export",
		sync_complete and _sync.last_transport == "sparse",
		"transport %s, next sequence %d" % [_sync.last_transport, _sync.next_sequence]
	)
	var total_visual_chunks := 0
	for child in _root.get_children():
		if String(child.get_meta("layer_id", "")) == finest.id:
			total_visual_chunks = child.get_child_count()
			break
	var total_collision_chunks := 0
	for child in collision.get_children():
		if String(child.get_meta("layer_id", "")) == finest.id:
			total_collision_chunks += 1
	var refreshed_visual := int(_sync.last_refresh.get("visual_chunks", 0))
	var refreshed_collision := int(_sync.last_refresh.get("collision_chunks", 0))
	_step(
		"only intersecting chunks refresh",
		refreshed_visual > 0
			and refreshed_collision > 0
			and refreshed_visual < total_visual_chunks
			and refreshed_collision < total_collision_chunks,
		"visual %d/%d, collision %d/%d" % [
			refreshed_visual, total_visual_chunks, refreshed_collision, total_collision_chunks
		]
	)

	await physics_frame
	await physics_frame

	# --- 9. confirm the updated collision geometry ---------------------------
	var after_rpc := await _rpc(
		"terrain.getHeight", {"x": collision_probe_x, "z": collision_probe_z}
	)
	if not after_rpc["error"].is_empty() or typeof(after_rpc["result"]) != TYPE_DICTIONARY:
		_step("read post-edit sidecar height", false, after_rpc["error"])
		_finish(false, "post-edit height request failed")
		return
	var after_h := float((after_rpc["result"] as Dictionary).get("elevationM", 0.0))

	var space2 := _root.get_world_3d().direct_space_state
	var q1 := PhysicsRayQueryParameters3D.create(
		Vector3(collision_probe_x, after_h + 50.0, collision_probe_z),
		Vector3(collision_probe_x, after_h - 50.0, collision_probe_z)
	)
	var hit1 := space2.intersect_ray(q1)
	var collision_after: float = float((hit1["position"] as Vector3).y) if not hit1.is_empty() else NAN

	_step("sidecar recorded the excavation",
		absf((before_h - after_h) - depth) < 0.02,
		"%.4f m -> %.4f m (expected -%.2f)" % [before_h, after_h, depth])

	_step("collision surface moved with it",
		not is_nan(collision_after) and absf(collision_after - after_h) < 0.01,
		"collision %.4f m vs sidecar %.4f m" % [collision_after, after_h])

	_step("collision actually changed",
		not is_nan(collision_before) and absf(collision_before - collision_after) > depth * 0.5,
		"before %.4f m, after %.4f m" % [collision_before, collision_after])

	# A mask-only edit larger than the sparse cap must use the real semantic tile
	# channel; the height checksum remains unchanged while the mask checksum moves.
	var paint := await _rpc("terrain.applyOperation", {
		"operation": {
			"kind": "semantic_paint",
			"layerId": finest.id,
			"centerXMeters": edit_x,
			"centerZMeters": edit_z,
			"radiusMeters": 8.0,
			"strengthMeters": 0.0,
			"falloff": 2.0,
			"semanticClass": "trench",
		}
	})
	var paint_delta: Dictionary = (
		(paint["result"] as Dictionary).get("delta", {}) if paint["error"].is_empty() else {}
	)
	if not paint_delta.is_empty():
		_sync.accept_delta(paint_delta)
	var paint_synced := (
		await _await_sync(int(paint_delta.get("sequenceNumber", -1)) + 1)
		if not paint_delta.is_empty()
		else false
	)
	var col := roundi((edit_x - finest.min_x) / finest.resolution_m)
	var row := roundi((edit_z - finest.min_z) / finest.resolution_m)
	var local_semantic := "unavailable"
	if paint_synced:
		var semantic_index := int(finest.semantic[row * finest.width_samples + col])
		local_semantic = String(finest.semantic_classes[semantic_index])
	var server_semantic := await _rpc("terrain.getSemanticClass", {"x": edit_x, "z": edit_z})
	var remote_semantic := (
		String((server_semantic["result"] as Dictionary).get("semanticClass", "unavailable"))
		if server_semantic["error"].is_empty()
		else "unavailable"
	)
	_step(
		"oversized semantic edit uses tile fallback",
		paint_synced
			and int(paint_delta.get("changedMaskSampleCount", 0)) > 65_536
			and paint_delta.has("maskSparseOmitted")
			and _sync.last_transport == "sparse+semantic_tile"
			and local_semantic == "trench"
			and remote_semantic == local_semantic,
		"%s · %s local/server · %s samples" % [
			_sync.last_transport,
			local_semantic,
			paint_delta.get("changedMaskSampleCount", 0),
		]
	)

	# Find a real heightfield point whose reseat halo contains no modelled rock.
	# A tiny edit there must not pay for another complete rock JSON transfer and
	# MultiMesh/collision rebuild.
	var quiet_radius: float = maxf(0.1, finest.resolution_m * 2.0)
	var quiet_clearance: float = quiet_radius + finest.resolution_m * 2.0
	var quiet_point := Vector2(INF, INF)
	var candidate_step := maxi(1, ceili(1.0 / finest.resolution_m))
	for candidate_row in range(4, finest.height_samples - 4, candidate_step):
		if is_finite(quiet_point.x):
			break
		for candidate_col in range(4, finest.width_samples - 4, candidate_step):
			var candidate := Vector2(
				finest.min_x + float(candidate_col) * finest.resolution_m,
				finest.min_z + float(candidate_row) * finest.resolution_m
			)
			var clear := true
			for rock_variant in rock_payload.get("rocks", []) as Array:
				var position: Array = (rock_variant as Dictionary).get("position_m", [])
				if position.size() == 3 and candidate.distance_to(
					Vector2(float(position[0]), float(position[2]))
				) <= quiet_clearance:
					clear = false
					break
			if clear:
				quiet_point = candidate
				break
	var quiet_delta: Dictionary = {}
	if is_finite(quiet_point.x):
		# Keep the periodic poll from consuming this authoritative delta before
		# its deliberately inconsistent digest mutation is exercised below.
		_sync.active = false
		var quiet_edit := await _rpc("terrain.applyOperation", {
			"operation": {
				"kind": "raise",
				"layerId": finest.id,
				"centerXMeters": quiet_point.x,
				"centerZMeters": quiet_point.y,
				"radiusMeters": quiet_radius,
				"strengthMeters": 0.005,
				"falloff": 2.0,
				"massConserving": false,
			}
		})
		if quiet_edit["error"].is_empty():
			quiet_delta = (quiet_edit["result"] as Dictionary).get("delta", {})
	var quiet_before_heights: PackedFloat32Array = finest.heights.duplicate()
	var quiet_before_semantic: PackedByteArray = finest.semantic.duplicate()
	var quiet_before_sequence: int = _sync.next_sequence
	var quiet_before_transfer: String = _sync._baseline_rock_transfer_sha
	var alternate_real_transfer := String(d.get("previousRockTransferSha256", ""))
	var invalid_zero_rock_delta := quiet_delta.duplicate(true)
	var zero_rock_contract_testable := (
		not quiet_delta.is_empty()
		and int(quiet_delta.get("rocksReseated", -1)) == 0
		and String(quiet_delta.get("previousRockTransferSha256", ""))
			== String(quiet_delta.get("resultingRockTransferSha256", ""))
		and alternate_real_transfer != quiet_before_transfer
	)
	if zero_rock_contract_testable:
		invalid_zero_rock_delta["resultingRockTransferSha256"] = alternate_real_transfer
		_sync.last_refresh = {"transaction_probe": "untouched"}
		_sync.call("_apply_or_fetch_tile", invalid_zero_rock_delta)
	var zero_rock_mismatch_rejected: bool = (
		zero_rock_contract_testable
		and bool(
			_sync.call(
				"_verify_layer_checksum",
				finest.id,
				quiet_delta.get("previousChecksum", ""),
				"height"
			)
		)
		and bool(
			_sync.call(
				"_verify_layer_checksum",
				finest.id,
				quiet_delta.get("previousMaskChecksum", ""),
				"semantic"
			)
		)
		and _sync.next_sequence == quiet_before_sequence
		and _sync._baseline_rock_transfer_sha == quiet_before_transfer
		and _sync.last_refresh.get("transaction_probe", "") == "untouched"
	)
	_step(
		"zero-rock delta rejects a changed rock digest",
		zero_rock_mismatch_rejected,
		"real reseat count %s · digest unchanged %s · rejected %s"
		% [
			quiet_delta.get("rocksReseated", "missing"),
			String(quiet_delta.get("previousRockTransferSha256", ""))
				== String(quiet_delta.get("resultingRockTransferSha256", "")),
			zero_rock_mismatch_rejected,
		]
	)
	# Restore the real pre-delta authority after the intentional pre-fix failure.
	finest.heights = quiet_before_heights.duplicate()
	finest.semantic = quiet_before_semantic.duplicate()
	if not quiet_delta.is_empty():
		_loader.refresh_changed_bounds(
			_root, finest.id, quiet_delta.get("affectedBounds", {}) as Dictionary
		)
	_sync.next_sequence = quiet_before_sequence
	_sync._baseline_rock_transfer_sha = quiet_before_transfer
	_sync.active = true
	_sync.baseline_verified = true
	_sync.last_transport = "none"
	if not quiet_delta.is_empty():
		_sync.accept_delta(quiet_delta)
	var quiet_synced := (
		await _await_sync(int(quiet_delta.get("sequenceNumber", -1)) + 1)
		if not quiet_delta.is_empty()
		else false
	)
	_step(
		"zero-rock height edit skips full rock transfer",
		quiet_synced
			and int(quiet_delta.get("rocksReseated", -1)) == 0
			and _sync.last_rock_refresh == "skipped_unchanged",
		"point %s · reseated %s · refresh %s"
		% [quiet_point, quiet_delta.get("rocksReseated", "missing"), _sync.last_rock_refresh]
	)

	# Export only after the in-memory sync/collision checks. This validates the
	# edited authority state; it is not used as the transport or refresh path.
	var re_export := await _rpc("terrain.export", {"outputDirectory": _output_dir})
	_step("re-export after live sync", re_export["error"].is_empty(),
		(re_export["result"] as Dictionary).get("validation", {}) if re_export["error"].is_empty() else re_export["error"])
	var validation: Dictionary = {}
	if re_export["error"].is_empty():
		validation = (re_export["result"] as Dictionary).get("validation", {})
	_step("edited terrain still validates", bool(validation.get("passed", false)), validation)

	# Exercise the editor dock against this same real authority. Generation
	# completion must refresh the sidecar identity instead of leaving the label
	# blank/stale, and an explicit Disconnect must transition every dependent
	# control immediately.
	var dock_probe: Node = DockScript.new()
	root.add_child(dock_probe)
	dock_probe._url_edit.text = _url
	dock_probe._on_connect_pressed()
	var dock_waited := 0.0
	while (
		(not dock_probe.client.is_connected_to_sidecar() or not dock_probe._pending.is_empty())
		and dock_waited < RPC_TIMEOUT_SECONDS
	):
		await create_timer(0.05).timeout
		dock_waited += 0.05
	dock_probe._sidecar_dataset.clear()
	dock_probe._render_dataset_identity()
	if re_export["error"].is_empty():
		dock_probe._handle_export(re_export["result"] as Dictionary, false)
	dock_waited = 0.0
	while dock_probe._sidecar_dataset.is_empty() and dock_waited < RPC_TIMEOUT_SECONDS:
		await create_timer(0.05).timeout
		dock_waited += 0.05
	_step(
		"dock refreshes sidecar authority after export",
		String(dock_probe._sidecar_dataset.get("terrainId", ""))
			== String(identity_payload.get("terrainId", ""))
			and int(dock_probe._sidecar_dataset.get("datasetRevision", -1))
				== int(identity_payload.get("datasetRevision", -2)),
		dock_probe._dataset_label.text
	)
	var import_scene := Node3D.new()
	import_scene.name = "DockImportScene"
	root.add_child(import_scene)
	current_scene = import_scene
	var imported := {"root": null}
	dock_probe.terrain_imported.connect(
		func(imported_root: Node3D) -> void: imported["root"] = imported_root
	)
	dock_probe._output_edit.text = _output_dir
	dock_probe._on_import_pressed()
	var import_disabled_while_building: bool = dock_probe._import_button.disabled
	dock_waited = 0.0
	while imported["root"] == null and dock_waited < RPC_TIMEOUT_SECONDS:
		await create_timer(0.05).timeout
		dock_waited += 0.05
	_step(
		"dock import uses the incremental scene builder",
		import_disabled_while_building
			and imported["root"] != null
			and int(dock_probe._loader.last_async_yields) > 0
			and not dock_probe._import_button.disabled,
		"disabled while building %s · %s yields"
		% [import_disabled_while_building, dock_probe._loader.last_async_yields]
	)
	dock_probe.client.close()
	await process_frame
	_step(
		"dock explicit disconnect resets dependent state",
		dock_probe._status_label.text == "disconnected"
			and not dock_probe._connect_button.disabled
			and dock_probe._disconnect_button.disabled
			and dock_probe._apply_operation_button.disabled
			and dock_probe._sync_label.text == "live sync: disconnected",
		"status %s · sync %s" % [dock_probe._status_label.text, dock_probe._sync_label.text]
	)
	dock_probe.queue_free()

	var all_passed := _steps.all(func(s): return s["passed"])
	_finish(all_passed, "" if all_passed else "one or more steps failed")
