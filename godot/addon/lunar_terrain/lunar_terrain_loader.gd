class_name LunarTerrainLoader
extends RefCounted
## Loads a lunar-terrain-sidecar export into a Godot scene (spec §17).
##
## Reads the sidecar's manifest and raw float32 heightfields and builds:
##
##     LunarTerrainRoot
##     ├── ContextTerrain / MissionTerrain / OperationalTerrain  (chunk containers)
##     ├── TerrainCollision                                      (StaticBody3D)
##     ├── PhysicalRocks / VisualRocks                           (MultiMeshInstance3D)
##     ├── PhysicalRockCollision                                 (chunked StaticBody3D nodes)
##     └── TerrainMetadata                                       (Node)
##
## COORDINATE CONTRACT (manifest `coordinate_system`, ADR 0002):
##   right-handed, +X east, +Y up, +Z SOUTH — north is -Z.
##   Grid col increases +X; grid row increases +Z, so row 0 is northernmost.
##   Metres throughout. No scale factor and no axis swap are applied on import;
##   if one were needed, the sidecar's frame and Godot's would disagree and the
##   round-trip elevation check would fail loudly rather than silently.

const SCHEMA_VERSION := "1.0.0"
const BODY_FRAME := "MOON_ME"
const BODY_RADIUS_M := 1_737_400.0
const MIN_SITE_LONGITUDE_DEG := -180.0
const MAX_SITE_LONGITUDE_DEG := 360.0
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
const HEIGHT_FILE := "height.rf32"
const SEMANTIC_FILE := "semantic.r8"
const ELEVATION_SOURCE_FILE := "elevation_source.r8"
const MAX_LAYERS := 64
const MAX_SAMPLES_PER_LAYER := 16_000_000
const MAX_TOTAL_ESTIMATED_BUILD_BYTES := 2 * 1024 * 1024 * 1024
# Conservative peak budget: retained height/masks, collision copies, render
# vertices/normals/indices, and the transient decoded buffers for a focused
# source-resolution build. Godot may use less for decimated distant chunks.
const ESTIMATED_BUILD_BYTES_PER_SAMPLE := 128
const MAX_JSON_ARTIFACT_BYTES := 128 * 1024 * 1024
const MAX_ROCKS := 50_000
const MAX_SPARSE_SAMPLES := 65_536
const VISUAL_CHUNK_QUADS := 128
const VISUAL_PREVIEW_MAX_SIDE := 512
const COLLISION_CHUNK_QUADS := 256
const ROCK_COLLISION_CELL_METERS := 16.0
const ROCK_COLLISION_MAX_SHAPES_PER_BODY := 128
const ROCK_INSTANCE_ASYNC_BATCH := 512
const TERRAIN_COLLISION_LAYER := 1
const ROCK_COLLISION_LAYER := 2
const SEMANTIC_CLASSES := [
	"unknown",
	"flat_regolith",
	"rough_regolith",
	"crater_floor",
	"crater_wall",
	"crater_rim",
	"rock_field",
	"berm",
	"trench",
	"compacted_surface",
	"disturbed_regolith",
	"unsafe_slope",
]
const ELEVATION_SOURCE_VALUES := ["synthetic", "measured", "measured_plus_synthetic"]


## One layer of the nested terrain.
class LayerData extends RefCounted:
	var id: String
	var role: String
	var resolution_m: float
	var width_samples: int
	var height_samples: int
	var min_x: float
	var min_z: float
	var max_x: float
	var max_z: float
	var min_y: float
	var max_y: float
	var heights: PackedFloat32Array
	var semantic: PackedByteArray
	var elevation_source: PackedByteArray
	var semantic_classes: PackedStringArray
	var elevation_source_values: PackedStringArray

	## Bilinear elevation at a world position. NAN outside the layer.
	func height_at(x: float, z: float) -> float:
		if not is_finite(x) or not is_finite(z):
			return NAN
		var fc := (x - min_x) / resolution_m
		var fr := (z - min_z) / resolution_m
		if fc < 0.0 or fr < 0.0 or fc > float(width_samples - 1) or fr > float(height_samples - 1):
			return NAN
		var c0 := int(floor(fc))
		var r0 := int(floor(fr))
		var c1: int = mini(c0 + 1, width_samples - 1)
		var r1: int = mini(r0 + 1, height_samples - 1)
		var tc := fc - float(c0)
		var tr := fr - float(r0)
		var h00 := heights[r0 * width_samples + c0]
		var h10 := heights[r0 * width_samples + c1]
		var h01 := heights[r1 * width_samples + c0]
		var h11 := heights[r1 * width_samples + c1]
		return (h00 * (1.0 - tc) * (1.0 - tr) + h10 * tc * (1.0 - tr)
			+ h01 * (1.0 - tc) * tr + h11 * tc * tr)


var manifest: Dictionary = {}
var layers: Array[LayerData] = []
var errors: PackedStringArray = []
var _root_dir: String = ""
var _artifacts_by_path: Dictionary = {}
var _rocks: Array = []
var _visual_focus_enabled := false
var _visual_focus := Vector3.ZERO
var _visual_focus_radius_m := 0.0
var last_async_yields := 0


## Mark a sensor/perception footprint that must retain source-grid visual
## geometry. Only the finest layer at this position is promoted; coarser tiers
## remain bounded previews underneath it.
func set_visual_focus(position: Vector3, radius_m: float) -> bool:
	if not is_finite(position.x) or not is_finite(position.z):
		errors.append("visual focus coordinates must be finite")
		return false
	if not is_finite(radius_m) or radius_m <= 0.0:
		errors.append("visual focus radius must be finite and positive")
		return false
	_visual_focus = position
	_visual_focus_radius_m = radius_m
	_visual_focus_enabled = true
	return true


func clear_visual_focus() -> void:
	_visual_focus_enabled = false
	_visual_focus_radius_m = 0.0


## Load a manifest and every layer it declares. Returns false on failure.
func load_export(directory: String) -> bool:
	_root_dir = directory
	errors.clear()
	layers.clear()
	manifest = {}
	_artifacts_by_path.clear()
	_rocks.clear()

	var manifest_path := directory.path_join("manifest.json")
	if not FileAccess.file_exists(manifest_path):
		errors.append("manifest.json not found at %s" % manifest_path)
		return false

	var manifest_file := FileAccess.open(manifest_path, FileAccess.READ)
	if manifest_file == null:
		errors.append("cannot open %s" % manifest_path)
		return false
	var manifest_bytes := manifest_file.get_length()
	if manifest_bytes < 1 or manifest_bytes > MAX_JSON_ARTIFACT_BYTES:
		manifest_file.close()
		errors.append(
			"manifest.json size must be between 1 and %d bytes" % MAX_JSON_ARTIFACT_BYTES
		)
		return false
	var text := manifest_file.get_as_text()
	manifest_file.close()
	var parsed: Variant = JSON.parse_string(text)
	if typeof(parsed) != TYPE_DICTIONARY:
		errors.append("manifest.json did not parse as an object")
		return false
	manifest = parsed

	if not _verify_manifest_header():
		return false
	if not _verify_coordinate_system():
		return false
	if not _verify_origin():
		return false
	if not _index_artifacts():
		return false
	if not _verify_manifest_memory_bound():
		return false

	var loaded_layers: Array[LayerData] = []
	for layer_variant in manifest.get("layers", []):
		if typeof(layer_variant) != TYPE_DICTIONARY:
			errors.append("manifest layers must contain objects")
			return false
		var layer := _load_layer_manifest(layer_variant as Dictionary)
		if layer == null:
			return false
		loaded_layers.append(layer)

	if not _verify_nested_layers(loaded_layers):
		return false
	# All schema, coordinate, geometry, nesting, and memory checks complete
	# before any height/mask buffer is allocated.
	for layer in loaded_layers:
		if not _load_heights(layer) or not _load_masks(layer):
			return false
	layers = loaded_layers
	if not _load_rocks_file():
		layers.clear()
		return false

	return errors.is_empty()


func _verify_manifest_header() -> bool:
	if manifest.get("schemaVersion", "") != SCHEMA_VERSION:
		errors.append(
			"unsupported manifest schemaVersion '%s'; expected '%s'"
			% [manifest.get("schemaVersion", ""), SCHEMA_VERSION]
		)
		return false
	if typeof(manifest.get("terrainId")) != TYPE_STRING or String(manifest.get("terrainId")).is_empty():
		errors.append("manifest terrainId must be a non-empty string")
		return false
	if typeof(manifest.get("seed")) != TYPE_STRING or String(manifest.get("seed")).is_empty():
		errors.append("manifest seed must be a non-empty string")
		return false
	if manifest.get("units", "") != "meters":
		errors.append("manifest units must be 'meters'")
		return false
	var layer_variants: Variant = manifest.get("layers")
	if typeof(layer_variants) != TYPE_ARRAY:
		errors.append("manifest layers must be an array")
		return false
	var layer_count := (layer_variants as Array).size()
	if layer_count < 1 or layer_count > MAX_LAYERS:
		errors.append("manifest layer count must be between 1 and %d" % MAX_LAYERS)
		return false
	return true


func _index_artifacts() -> bool:
	var artifact_variants: Variant = manifest.get("artifacts")
	if typeof(artifact_variants) != TYPE_ARRAY:
		errors.append("manifest artifacts must be an array")
		return false
	for artifact_variant in artifact_variants as Array:
		if typeof(artifact_variant) != TYPE_DICTIONARY:
			errors.append("manifest artifacts must contain objects")
			return false
		var artifact: Dictionary = artifact_variant
		if typeof(artifact.get("path")) != TYPE_STRING:
			errors.append("manifest artifact path must be a string")
			return false
		var relative_path := String(artifact.get("path"))
		if not _safe_relative_path(relative_path):
			errors.append("unsafe manifest artifact path '%s'" % relative_path)
			return false
		if _artifacts_by_path.has(relative_path):
			errors.append("duplicate manifest artifact path '%s'" % relative_path)
			return false
		_artifacts_by_path[relative_path] = artifact
	return true


func _safe_relative_path(path: String) -> bool:
	if path.is_empty() or path.is_absolute_path() or path.contains("\\"):
		return false
	for component in path.split("/"):
		if component.is_empty() or component == "." or component == "..":
			return false
	return true


func _safe_layer_id(id: String) -> bool:
	if id.is_empty():
		return false
	for i in id.length():
		var code := id.unicode_at(i)
		var allowed := (
			(code >= 48 and code <= 57)
			or (code >= 65 and code <= 90)
			or (code >= 97 and code <= 122)
			or code == 45
			or code == 95
		)
		if not allowed:
			return false
	return true


func _finite_number(value: Variant) -> bool:
	return (typeof(value) == TYPE_INT or typeof(value) == TYPE_FLOAT) and is_finite(float(value))


func _positive_integer(value: Variant) -> bool:
	return _finite_number(value) and float(value) >= 1.0 and float(value) == floor(float(value))


func _nonnegative_integer(value: Variant) -> bool:
	return _finite_number(value) and float(value) >= 0.0 and float(value) == floor(float(value))


func _verify_manifest_memory_bound() -> bool:
	var estimated_build_bytes := 0
	for layer_variant in manifest.get("layers", []):
		if typeof(layer_variant) != TYPE_DICTIONARY:
			return true # The detailed layer validation reports this immediately after.
		var lm: Dictionary = layer_variant
		var width_variant: Variant = lm.get("width_samples")
		var height_variant: Variant = lm.get("height_samples")
		if (
			not _positive_integer(width_variant)
			or not _positive_integer(height_variant)
			or float(width_variant) > float(MAX_SAMPLES_PER_LAYER)
			or float(height_variant) > float(MAX_SAMPLES_PER_LAYER)
		):
			return true # Detailed validation owns the field-specific message.
		var samples := int(width_variant) * int(height_variant)
		estimated_build_bytes += samples * ESTIMATED_BUILD_BYTES_PER_SAMPLE
		if estimated_build_bytes > MAX_TOTAL_ESTIMATED_BUILD_BYTES:
			errors.append(
				"manifest terrain has an estimated %d-byte peak build, above the importer limit %d"
				% [estimated_build_bytes, MAX_TOTAL_ESTIMATED_BUILD_BYTES]
			)
			return false
	return true


func _load_layer_manifest(lm: Dictionary) -> LayerData:
	if typeof(lm.get("id")) != TYPE_STRING or not _safe_layer_id(String(lm.get("id"))):
		errors.append("layer id must use only ASCII letters, digits, '-' and '_'")
		return null
	var id := String(lm.get("id"))
	var role := String(lm.get("role", ""))
	if role not in ["context", "mission", "operational"]:
		errors.append("layer '%s' has unsupported role '%s'" % [id, role])
		return null
	if not _finite_number(lm.get("resolution_m")) or float(lm.get("resolution_m")) <= 0.0:
		errors.append("layer '%s' resolution_m must be finite and positive" % id)
		return null
	if (
		not _positive_integer(lm.get("width_samples"))
		or not _positive_integer(lm.get("height_samples"))
		or float(lm.get("width_samples")) > float(MAX_SAMPLES_PER_LAYER)
		or float(lm.get("height_samples")) > float(MAX_SAMPLES_PER_LAYER)
	):
		errors.append("layer '%s' sample dimensions must be positive integers" % id)
		return null
	var width := int(lm.get("width_samples"))
	var height := int(lm.get("height_samples"))
	if width < 2 or height < 2:
		errors.append("layer '%s' requires at least 2 samples on each axis" % id)
		return null
	var sample_count := width * height
	if sample_count > MAX_SAMPLES_PER_LAYER:
		errors.append(
			"layer '%s' has %d samples, above the importer limit %d"
			% [id, sample_count, MAX_SAMPLES_PER_LAYER]
		)
		return null

	var bounds_variant: Variant = lm.get("bounds")
	if typeof(bounds_variant) != TYPE_DICTIONARY:
		errors.append("layer '%s' bounds must be an object" % id)
		return null
	var bounds: Dictionary = bounds_variant
	var minimum_variant: Variant = bounds.get("minimum")
	var maximum_variant: Variant = bounds.get("maximum")
	if typeof(minimum_variant) != TYPE_ARRAY or typeof(maximum_variant) != TYPE_ARRAY:
		errors.append("layer '%s' bounds minimum/maximum must be arrays" % id)
		return null
	var mn: Array = minimum_variant
	var mx: Array = maximum_variant
	if mn.size() != 3 or mx.size() != 3:
		errors.append("layer '%s' bounds minimum/maximum must each have 3 values" % id)
		return null
	for value in mn + mx:
		if not _finite_number(value):
			errors.append("layer '%s' bounds must contain only finite numbers" % id)
			return null
	var min_x := float(mn[0])
	var min_y := float(mn[1])
	var min_z := float(mn[2])
	var max_x := float(mx[0])
	var max_y := float(mx[1])
	var max_z := float(mx[2])
	if max_x <= min_x or max_z <= min_z or max_y < min_y:
		errors.append("layer '%s' bounds must be ordered and have positive X/Z extent" % id)
		return null
	var resolution := float(lm.get("resolution_m"))
	var tolerance := maxf(1.0e-6, resolution * 1.0e-6)
	if (
		absf((max_x - min_x) - float(width - 1) * resolution) > tolerance
		or absf((max_z - min_z) - float(height - 1) * resolution) > tolerance
	):
		errors.append("layer '%s' bounds do not match its samples and resolution" % id)
		return null

	var layer := LayerData.new()
	layer.id = id
	layer.role = role
	layer.resolution_m = resolution
	layer.width_samples = width
	layer.height_samples = height
	layer.min_x = min_x
	layer.min_y = min_y
	layer.min_z = min_z
	layer.max_x = max_x
	layer.max_y = max_y
	layer.max_z = max_z
	return layer


func _verify_nested_layers(loaded_layers: Array[LayerData]) -> bool:
	var ids: Dictionary = {}
	var roles: Dictionary = {}
	for layer in loaded_layers:
		if ids.has(layer.id):
			errors.append("duplicate layer id '%s'" % layer.id)
			return false
		ids[layer.id] = true
		if roles.has(layer.role):
			errors.append("duplicate layer role '%s'" % layer.role)
			return false
		roles[layer.role] = true
	var sorted_layers := loaded_layers.duplicate()
	sorted_layers.sort_custom(func(a, b): return a.resolution_m > b.resolution_m)
	for i in range(1, sorted_layers.size()):
		var coarse: LayerData = sorted_layers[i - 1]
		var fine: LayerData = sorted_layers[i]
		if fine.resolution_m >= coarse.resolution_m:
			errors.append("nested layers must have distinct, progressively finer resolutions")
			return false
		if (
			fine.min_x < coarse.min_x
			or fine.max_x > coarse.max_x
			or fine.min_z < coarse.min_z
			or fine.max_z > coarse.max_z
		):
			errors.append("layer '%s' is not contained within '%s'" % [fine.id, coarse.id])
			return false
		for boundary in [fine.min_x, fine.max_x]:
			var coarse_col := (float(boundary) - coarse.min_x) / coarse.resolution_m
			if absf(coarse_col - roundf(coarse_col)) > 1.0e-5:
				errors.append(
					"layer '%s' X bounds do not align to '%s' collision samples"
					% [fine.id, coarse.id]
				)
				return false
		for boundary in [fine.min_z, fine.max_z]:
			var coarse_row := (float(boundary) - coarse.min_z) / coarse.resolution_m
			if absf(coarse_row - roundf(coarse_row)) > 1.0e-5:
				errors.append(
					"layer '%s' Z bounds do not align to '%s' collision samples"
					% [fine.id, coarse.id]
				)
				return false
	return true


## The sidecar declares its frame explicitly; refuse anything unexpected rather
## than importing a mirrored or inside-out site.
func _verify_coordinate_system() -> bool:
	var cs_variant: Variant = manifest.get("coordinate_system")
	if typeof(cs_variant) != TYPE_DICTIONARY:
		errors.append("manifest coordinate_system must be an object")
		return false
	var cs: Dictionary = cs_variant
	if cs.is_empty():
		errors.append("manifest declares no coordinate_system")
		return false
	if cs.get("handedness", "") != "right":
		errors.append("expected a right-handed frame, got '%s'" % cs.get("handedness", ""))
		return false
	if cs.get("up_axis", "") != "+Y":
		errors.append("expected +Y up, got '%s'" % cs.get("up_axis", ""))
		return false
	if cs.get("east_axis", "") != "+X":
		errors.append("expected east on +X, got '%s'" % cs.get("east_axis", ""))
		return false
	if cs.get("north_axis", "") != "-Z":
		errors.append("expected north on -Z, got '%s'" % cs.get("north_axis", ""))
		return false
	if cs.get("south_axis", "") != "+Z":
		errors.append("expected south on +Z, got '%s'" % cs.get("south_axis", ""))
		return false
	if cs.get("linear_unit", "") != "meter":
		errors.append("expected metres, got '%s'" % cs.get("linear_unit", ""))
		return false
	if cs.get("angular_unit", "") != "degree":
		errors.append("expected angular degrees, got '%s'" % cs.get("angular_unit", ""))
		return false
	if cs.get("body_frame", "") != BODY_FRAME:
		errors.append(
			"expected coordinate_system.body_frame '%s', got '%s'"
			% [BODY_FRAME, cs.get("body_frame", "")]
		)
		return false
	var body_radius_variant: Variant = cs.get("body_radius_m")
	if (
		not _finite_number(body_radius_variant)
		or float(body_radius_variant) != BODY_RADIUS_M
	):
		errors.append(
			"expected coordinate_system.body_radius_m %.0f, got '%s'"
			% [BODY_RADIUS_M, body_radius_variant]
		)
		return false
	if not _verify_source_projection(cs):
		return false
	return true


## Projection metadata is optional for terrain without a projected DEM. When
## present, fail closed on the exact schema before any artifact is opened: an
## unchecked scale, offset, or body radius would silently move the lunar site.
func _verify_source_projection(coordinate_system: Dictionary) -> bool:
	if not coordinate_system.has("source_projection"):
		return true
	var projection_variant: Variant = coordinate_system.get("source_projection")
	if typeof(projection_variant) != TYPE_DICTIONARY:
		errors.append("manifest coordinate_system.source_projection must be an object")
		return false
	var projection: Dictionary = projection_variant
	if projection.get("type") != "polar_stereographic":
		errors.append(
			"manifest coordinate_system.source_projection.type must be 'polar_stereographic'"
		)
		return false
	for key in SOURCE_PROJECTION_NUMBER_FIELDS:
		if not _finite_number(projection.get(key)):
			errors.append(
				"manifest coordinate_system.source_projection.%s must be finite" % key
			)
			return false
	if projection.size() != SOURCE_PROJECTION_NUMBER_FIELDS.size() + 1:
		errors.append(
			"manifest coordinate_system.source_projection must contain exactly 9 fields"
		)
		return false
	if float(projection.get("bodyRadiusM")) != float(coordinate_system.get("body_radius_m")):
		errors.append(
			"manifest coordinate_system.source_projection.bodyRadiusM must equal body_radius_m"
		)
		return false
	var latitude_of_origin := float(projection.get("latitudeOfOriginDeg"))
	if latitude_of_origin != -90.0 and latitude_of_origin != 90.0:
		errors.append(
			"manifest coordinate_system.source_projection.latitudeOfOriginDeg must be -90 or 90"
		)
		return false
	var central_meridian := float(projection.get("centralMeridianDeg"))
	if central_meridian < MIN_SITE_LONGITUDE_DEG or central_meridian > MAX_SITE_LONGITUDE_DEG:
		errors.append(
			"manifest coordinate_system.source_projection.centralMeridianDeg must be within -180..360"
		)
		return false
	if float(projection.get("scaleFactor")) <= 0.0:
		errors.append(
			"manifest coordinate_system.source_projection.scaleFactor must be positive"
		)
		return false
	return true


## Validate the local-frame anchor before any raster is opened. These fields
## are required by the export schema: terrain vertices are local metres, while
## the site and datum recover their physical location in the MOON_ME frame.
func _verify_origin() -> bool:
	var origin_variant: Variant = manifest.get("origin")
	if typeof(origin_variant) != TYPE_DICTIONARY:
		errors.append("manifest origin must be an object")
		return false
	var origin: Dictionary = origin_variant

	var local_variant: Variant = origin.get("local")
	if typeof(local_variant) != TYPE_ARRAY or (local_variant as Array).size() != 3:
		errors.append("manifest origin.local must contain 3 finite metre values")
		return false
	for value in local_variant as Array:
		if not _finite_number(value):
			errors.append("manifest origin.local must contain 3 finite metre values")
			return false

	var site_variant: Variant = origin.get("site_selenographic")
	if typeof(site_variant) != TYPE_DICTIONARY:
		errors.append("manifest origin.site_selenographic must be an object")
		return false
	var site: Dictionary = site_variant
	var latitude_variant: Variant = site.get("latitude_deg")
	if (
		not _finite_number(latitude_variant)
		or float(latitude_variant) < -90.0
		or float(latitude_variant) > 90.0
	):
		errors.append(
			"manifest origin.site_selenographic.latitude_deg must be finite and within -90..90"
		)
		return false
	var longitude_variant: Variant = site.get("longitude_deg")
	if (
		not _finite_number(longitude_variant)
		or float(longitude_variant) < MIN_SITE_LONGITUDE_DEG
		or float(longitude_variant) > MAX_SITE_LONGITUDE_DEG
	):
		errors.append(
			"manifest origin.site_selenographic.longitude_deg must be finite and within -180..360"
		)
		return false

	if not _finite_number(origin.get("datum_elevation_m")):
		errors.append("manifest origin.datum_elevation_m must be finite")
		return false
	return true


func _load_heights(layer: LayerData) -> bool:
	var relative_path := "layers/%s/%s" % [layer.id, HEIGHT_FILE]
	var artifact := _artifact(relative_path, "heightmap_raw_f32")
	if artifact.is_empty():
		return false
	var encoding_variant: Variant = artifact.get("encoding")
	if typeof(encoding_variant) != TYPE_DICTIONARY:
		errors.append("%s declares no RF32 encoding object" % relative_path)
		return false
	var encoding: Dictionary = encoding_variant
	if (
		encoding.get("dtype", "") != "<f4"
		or encoding.get("order", "") != "row-major-C"
		or encoding.get("units", "") != "meter"
		or not _positive_integer(encoding.get("widthSamples"))
		or not _positive_integer(encoding.get("heightSamples"))
		or int(encoding.get("widthSamples", -1)) != layer.width_samples
		or int(encoding.get("heightSamples", -1)) != layer.height_samples
	):
		errors.append("%s has an incompatible RF32 encoding declaration" % relative_path)
		return false

	var expected := layer.width_samples * layer.height_samples
	var bytes := _verified_artifact_bytes(relative_path, artifact, expected * 4)
	if bytes.is_empty():
		return false

	# Row-major float32. to_float32_array() is NATIVE-endian; the file is
	# little-endian per the manifest. Every platform Godot 4 ships on is
	# little-endian, so these coincide — noted so a future big-endian port
	# knows this is the line to fix rather than trusting the old comment.
	layer.heights = bytes.to_float32_array()
	if layer.heights.size() != expected:
		errors.append("%s did not decode to %d float32 samples" % [relative_path, expected])
		return false
	var actual_min := INF
	var actual_max := -INF
	for height in layer.heights:
		if not is_finite(height):
			errors.append("%s contains NaN or infinite elevations" % relative_path)
			return false
		actual_min = minf(actual_min, height)
		actual_max = maxf(actual_max, height)
	if actual_min < layer.min_y - 1.0e-5 or actual_max > layer.max_y + 1.0e-5:
		errors.append("%s elevations exceed the manifest Y bounds" % relative_path)
		return false
	return true


func _load_masks(layer: LayerData) -> bool:
	var semantic_path := "layers/%s/%s" % [layer.id, SEMANTIC_FILE]
	var semantic_artifact := _artifact(semantic_path, "semantic_raw_u8")
	if semantic_artifact.is_empty():
		return false
	if not semantic_artifact.is_empty():
		if semantic_artifact.get("kind", "") != "semantic_raw_u8":
			errors.append("%s must be declared as semantic_raw_u8" % semantic_path)
			return false
		var semantic_encoding_variant: Variant = semantic_artifact.get("encoding")
		if typeof(semantic_encoding_variant) != TYPE_DICTIONARY:
			errors.append("%s declares no encoding object" % semantic_path)
			return false
		var semantic_encoding: Dictionary = semantic_encoding_variant
		if (
			semantic_encoding.get("dtype", "") != "u1"
			or not _positive_integer(semantic_encoding.get("widthSamples"))
			or not _positive_integer(semantic_encoding.get("heightSamples"))
			or int(semantic_encoding.get("widthSamples", -1)) != layer.width_samples
			or int(semantic_encoding.get("heightSamples", -1)) != layer.height_samples
			or typeof(semantic_encoding.get("classes")) != TYPE_ARRAY
		):
			errors.append("%s has an incompatible semantic-mask encoding" % semantic_path)
			return false
		for class_variant in semantic_encoding.get("classes") as Array:
			if typeof(class_variant) != TYPE_STRING or String(class_variant).is_empty():
				errors.append("%s semantic classes must be non-empty strings" % semantic_path)
				return false
			layer.semantic_classes.append(String(class_variant))
		if layer.semantic_classes.is_empty():
			errors.append("%s declares no semantic classes" % semantic_path)
			return false
		if Array(layer.semantic_classes) != SEMANTIC_CLASSES:
			errors.append("%s semantic classes do not match schema %s" % [semantic_path, SCHEMA_VERSION])
			return false
		layer.semantic = _verified_artifact_bytes(
			semantic_path,
			semantic_artifact,
			layer.width_samples * layer.height_samples
		)
		if layer.semantic.is_empty():
			return false
		for value in layer.semantic:
			if int(value) >= layer.semantic_classes.size():
				errors.append("%s contains an undeclared semantic class index" % semantic_path)
				return false

	var source_path := "layers/%s/%s" % [layer.id, ELEVATION_SOURCE_FILE]
	var source_artifact := _artifact(source_path, "elevation_source_raw_u8")
	if source_artifact.is_empty():
		return false
	if not source_artifact.is_empty():
		if source_artifact.get("kind", "") != "elevation_source_raw_u8":
			errors.append("%s must be declared as elevation_source_raw_u8" % source_path)
			return false
		var source_encoding_variant: Variant = source_artifact.get("encoding")
		if typeof(source_encoding_variant) != TYPE_DICTIONARY:
			errors.append("%s declares no encoding object" % source_path)
			return false
		var source_encoding: Dictionary = source_encoding_variant
		if (
			source_encoding.get("dtype", "") != "u1"
			or typeof(source_encoding.get("values")) != TYPE_ARRAY
		):
			errors.append("%s has an incompatible provenance-mask encoding" % source_path)
			return false
		for value_variant in source_encoding.get("values") as Array:
			if typeof(value_variant) != TYPE_STRING or String(value_variant).is_empty():
				errors.append("%s provenance values must be non-empty strings" % source_path)
				return false
			layer.elevation_source_values.append(String(value_variant))
		if layer.elevation_source_values.is_empty():
			errors.append("%s declares no provenance values" % source_path)
			return false
		if Array(layer.elevation_source_values) != ELEVATION_SOURCE_VALUES:
			errors.append("%s provenance values do not match schema %s" % [source_path, SCHEMA_VERSION])
			return false
		layer.elevation_source = _verified_artifact_bytes(
			source_path,
			source_artifact,
			layer.width_samples * layer.height_samples
		)
		if layer.elevation_source.is_empty():
			return false
		for value in layer.elevation_source:
			if int(value) >= layer.elevation_source_values.size():
				errors.append("%s contains an undeclared provenance index" % source_path)
				return false
	return true


func _artifact(relative_path: String, expected_kind: String) -> Dictionary:
	if not _artifacts_by_path.has(relative_path):
		errors.append("manifest does not declare required artifact '%s'" % relative_path)
		return {}
	var artifact: Dictionary = _artifacts_by_path[relative_path]
	if artifact.get("kind", "") != expected_kind:
		errors.append(
			"artifact '%s' has kind '%s'; expected '%s'"
			% [relative_path, artifact.get("kind", ""), expected_kind]
		)
		return {}
	return artifact


func _verified_artifact_bytes(
	relative_path: String, artifact: Dictionary, expected_bytes: int = -1
) -> PackedByteArray:
	if not _positive_integer(artifact.get("bytes")):
		errors.append("artifact '%s' declares an invalid byte count" % relative_path)
		return PackedByteArray()
	var declared_bytes := int(artifact.get("bytes"))
	if expected_bytes >= 0 and declared_bytes != expected_bytes:
		errors.append(
			"artifact '%s' declares %d bytes; encoding requires %d"
			% [relative_path, declared_bytes, expected_bytes]
		)
		return PackedByteArray()
	if expected_bytes < 0 and declared_bytes > MAX_JSON_ARTIFACT_BYTES:
		errors.append(
			"artifact '%s' exceeds the %d-byte JSON import limit"
			% [relative_path, MAX_JSON_ARTIFACT_BYTES]
		)
		return PackedByteArray()
	var expected_sha := String(artifact.get("sha256", "")).to_lower()
	if expected_sha.length() != 64 or not expected_sha.is_valid_hex_number(false):
		errors.append("artifact '%s' declares an invalid SHA-256 digest" % relative_path)
		return PackedByteArray()

	var path := _root_dir.path_join(relative_path)
	var f := FileAccess.open(path, FileAccess.READ)
	if f == null:
		errors.append("cannot open %s" % path)
		return PackedByteArray()
	var actual_bytes := f.get_length()
	if actual_bytes != declared_bytes:
		f.close()
		errors.append(
			"%s: manifest declares %d bytes, file has %d"
			% [path, declared_bytes, actual_bytes]
		)
		return PackedByteArray()
	var bytes := f.get_buffer(actual_bytes)
	f.close()
	if bytes.size() != actual_bytes:
		errors.append("%s: short read (%d of %d bytes)" % [path, bytes.size(), actual_bytes])
		return PackedByteArray()

	var hashing := HashingContext.new()
	if hashing.start(HashingContext.HASH_SHA256) != OK or hashing.update(bytes) != OK:
		errors.append("could not initialize SHA-256 verification for %s" % path)
		return PackedByteArray()
	var actual_sha := hashing.finish().hex_encode()
	if actual_sha != expected_sha:
		errors.append(
			"%s: SHA-256 mismatch (manifest %s, actual %s)"
			% [path, expected_sha, actual_sha]
		)
		return PackedByteArray()
	return bytes


func _load_rocks_file() -> bool:
	var relative_path := "rocks.json"
	var artifact := _artifact(relative_path, "rock_manifest")
	if artifact.is_empty():
		return false
	var bytes := _verified_artifact_bytes(relative_path, artifact)
	if bytes.is_empty():
		return false
	var parsed: Variant = JSON.parse_string(bytes.get_string_from_utf8())
	if typeof(parsed) != TYPE_DICTIONARY:
		errors.append("rocks.json did not parse as an object")
		return false
	var payload: Dictionary = parsed
	if payload.get("schemaVersion", "") != SCHEMA_VERSION:
		errors.append("rocks.json has an unsupported schemaVersion")
		return false
	if payload.get("terrainId", "") != manifest.get("terrainId", ""):
		errors.append("rocks.json terrainId does not match manifest.json")
		return false
	if payload.get("units", "") != "meters":
		errors.append("rocks.json units must be 'meters'")
		return false
	var validated := _validate_rocks_payload(payload, false)
	if not bool(validated.get("ok", false)):
		errors.append(String(validated.get("error", "invalid rocks.json")))
		return false
	_rocks = validated.get("rocks", [])
	return true


func _validate_rocks_payload(payload: Dictionary, live_payload: bool) -> Dictionary:
	if live_payload and bool(payload.get("truncated", false)):
		return {"ok": false, "error": "refusing a truncated rock payload for physics"}
	var rocks_variant: Variant = payload.get("rocks")
	if typeof(rocks_variant) != TYPE_ARRAY:
		return {"ok": false, "error": "rock payload must contain a rocks array"}
	var rocks: Array = rocks_variant
	if rocks.size() > MAX_ROCKS:
		return {
			"ok": false,
			"error": "rock payload has %d instances, above the importer limit %d"
				% [rocks.size(), MAX_ROCKS],
		}
	var declared_count_key := "returnedCount" if live_payload else "count"
	if not _nonnegative_integer(payload.get(declared_count_key)):
		return {"ok": false, "error": "rock payload declares an invalid count"}
	if int(payload.get(declared_count_key, 0)) != rocks.size():
		return {"ok": false, "error": "rock payload count does not match its rocks array"}
	if live_payload:
		if not _nonnegative_integer(payload.get("totalCount")):
			return {"ok": false, "error": "rock payload declares an invalid totalCount"}
		if int(payload.get("totalCount")) != rocks.size():
			return {
				"ok": false,
				"error": "complete rock payload totalCount does not match its rocks array",
			}
	if not _nonnegative_integer(payload.get("physicalCount")):
		return {"ok": false, "error": "rock payload declares an invalid physicalCount"}

	var ids: Dictionary = {}
	var physical_count := 0
	var terrain_extent_m := 0.0
	for layer in layers:
		terrain_extent_m = maxf(
			terrain_extent_m,
			maxf(layer.max_x - layer.min_x, layer.max_z - layer.min_z)
		)
	for index in rocks.size():
		var rock_variant: Variant = rocks[index]
		if typeof(rock_variant) != TYPE_DICTIONARY:
			return {"ok": false, "error": "rocks[%d] is not an object" % index}
		var rock: Dictionary = rock_variant
		if typeof(rock.get("id")) != TYPE_STRING:
			return {"ok": false, "error": "rocks[%d] id must be a string" % index}
		var id := String(rock.get("id"))
		if id.is_empty() or ids.has(id):
			return {"ok": false, "error": "rocks[%d] has a missing or duplicate id" % index}
		ids[id] = true
		if typeof(rock.get("physical")) != TYPE_BOOL:
			return {"ok": false, "error": "rock '%s' physical must be boolean" % id}
		var p_variant: Variant = rock.get("position_m")
		var s_variant: Variant = rock.get("scale_m")
		var q_variant: Variant = rock.get("rotation_quaternion")
		if (
			typeof(p_variant) != TYPE_ARRAY
			or typeof(s_variant) != TYPE_ARRAY
			or typeof(q_variant) != TYPE_ARRAY
			or (p_variant as Array).size() != 3
			or (s_variant as Array).size() != 3
			or (q_variant as Array).size() != 4
		):
			return {"ok": false, "error": "rock '%s' has invalid transform arrays" % id}
		var p: Array = p_variant
		var s: Array = s_variant
		var q: Array = q_variant
		for value in p + s + q:
			if not _finite_number(value):
				return {"ok": false, "error": "rock '%s' transform is not finite" % id}
		var position := Vector3(float(p[0]), float(p[1]), float(p[2]))
		var scale := Vector3(float(s[0]), float(s[1]), float(s[2]))
		var rotation := Quaternion(float(q[0]), float(q[1]), float(q[2]), float(q[3]))
		if not position.is_finite() or not scale.is_finite() or not rotation.is_finite():
			return {"ok": false, "error": "rock '%s' transform exceeds Godot precision" % id}
		if scale.x <= 0.0 or scale.y <= 0.0 or scale.z <= 0.0:
			return {"ok": false, "error": "rock '%s' scale must be positive" % id}
		if maxf(scale.x, maxf(scale.y, scale.z)) > terrain_extent_m:
			return {"ok": false, "error": "rock '%s' scale exceeds the terrain extent" % id}
		var rock_layer := finest_layer_at(position.x, position.z)
		if rock_layer == null:
			return {"ok": false, "error": "rock '%s' lies outside the loaded terrain" % id}
		var ground_y: float = rock_layer.height_at(position.x, position.z)
		if position.y - scale.y > ground_y + 1.0e-3:
			return {"ok": false, "error": "rock '%s' floats entirely above the terrain" % id}
		if position.y < ground_y - terrain_extent_m:
			return {"ok": false, "error": "rock '%s' lies below the bounded terrain volume" % id}
		var quaternion_norm := rotation.length()
		if not is_finite(quaternion_norm) or quaternion_norm <= 1.0e-8:
			return {"ok": false, "error": "rock '%s' quaternion has invalid length" % id}
		if absf(quaternion_norm - 1.0) > 1.0e-3:
			return {"ok": false, "error": "rock '%s' quaternion must be normalized" % id}
		if bool(rock.get("physical")):
			physical_count += 1

	if int(payload.get("physicalCount")) != physical_count:
		return {"ok": false, "error": "rock payload physicalCount does not match its rocks"}
	return {"ok": true, "rocks": rocks, "physical_count": physical_count}


## Build the scene graph. `parent` receives a single LunarTerrainRoot child.
func build_scene(parent: Node) -> Node3D:
	last_async_yields = 0
	if layers.is_empty() or not errors.is_empty():
		errors.append("cannot build terrain before a valid export is loaded")
		return null
	var root := Node3D.new()
	root.name = "LunarTerrainRoot"
	parent.add_child(root)

	var collision_parent := StaticBody3D.new()
	collision_parent.name = "TerrainCollision"
	collision_parent.collision_layer = TERRAIN_COLLISION_LAYER
	collision_parent.collision_mask = 0
	root.add_child(collision_parent)

	for layer in layers:
		var layer_container := Node3D.new()
		layer_container.name = _node_name_for_role(layer.role)
		layer_container.set_meta("layer_id", layer.id)
		root.add_child(layer_container)
		_build_visual_chunks(layer_container, layer)

	_build_collision(collision_parent)
	_build_rocks(root)
	_build_metadata(root)
	root.set_meta("async_build_yields", 0)
	return root


## Incremental equivalent of build_scene. Each visual/collision chunk or
## bounded rock batch counts as one work item, and control returns to the scene
## tree after `chunks_per_frame` items so importing a large site does not hold
## the main thread for the entire build.
func build_scene_async(parent: Node, chunks_per_frame: int = 4) -> Node3D:
	last_async_yields = 0
	if layers.is_empty() or not errors.is_empty():
		errors.append("cannot build terrain before a valid export is loaded")
		return null
	if chunks_per_frame < 1:
		errors.append("chunks_per_frame must be positive")
		return null
	var tree: SceneTree = parent.get_tree() if parent.is_inside_tree() else null
	if tree == null and Engine.get_main_loop() is SceneTree:
		tree = Engine.get_main_loop() as SceneTree
	if tree == null:
		errors.append("async terrain build requires a parent inside a SceneTree")
		return null

	var root := Node3D.new()
	root.name = "LunarTerrainRoot"
	parent.add_child(root)
	var collision_parent := StaticBody3D.new()
	collision_parent.name = "TerrainCollision"
	collision_parent.collision_layer = TERRAIN_COLLISION_LAYER
	collision_parent.collision_mask = 0
	root.add_child(collision_parent)

	var work_items := 0
	for layer in layers:
		var layer_container := Node3D.new()
		layer_container.name = _node_name_for_role(layer.role)
		layer_container.set_meta("layer_id", layer.id)
		root.add_child(layer_container)
		var row0 := 0
		while row0 < layer.height_samples - 1:
			var h := mini(VISUAL_CHUNK_QUADS + 1, layer.height_samples - row0)
			var col0 := 0
			while col0 < layer.width_samples - 1:
				var w := mini(VISUAL_CHUNK_QUADS + 1, layer.width_samples - col0)
				_add_visual_chunk(layer_container, layer, col0, row0, w, h)
				work_items += 1
				if work_items >= chunks_per_frame:
					work_items = 0
					last_async_yields += 1
					await tree.process_frame
				col0 += VISUAL_CHUNK_QUADS
			row0 += VISUAL_CHUNK_QUADS

	for spec_variant in _collision_chunk_specs():
		var spec: Dictionary = spec_variant
		_add_collision_chunk(
			collision_parent,
			spec.get("layer") as LayerData,
			int(spec.get("col0")),
			int(spec.get("row0")),
			int(spec.get("width")),
			int(spec.get("height")),
			String(spec.get("tag"))
		)
		work_items += 1
		if work_items >= chunks_per_frame:
			work_items = 0
			last_async_yields += 1
			await tree.process_frame

	var physical: Array = []
	var visual: Array = []
	for rock_variant in _rocks:
		var rock: Dictionary = rock_variant
		if bool(rock.get("physical", false)):
			physical.append(rock)
		else:
			visual.append(rock)
	for rock_set in [
		{"name": "PhysicalRocks", "rocks": physical},
		{"name": "VisualRocks", "rocks": visual},
	]:
		var rock_list: Array = rock_set.get("rocks")
		var rock_node := _new_rock_multimesh(String(rock_set.get("name")), rock_list.size())
		for i in rock_list.size():
			_set_rock_instance(rock_node.multimesh, i, rock_list[i])
			if (i + 1) % ROCK_INSTANCE_ASYNC_BATCH == 0 or i + 1 == rock_list.size():
				work_items += 1
				if work_items >= chunks_per_frame:
					work_items = 0
					last_async_yields += 1
					await tree.process_frame
		root.add_child(rock_node)

	var rock_collision := Node3D.new()
	rock_collision.name = "PhysicalRockCollision"
	for cell_variant in _rock_collision_cells(physical):
		var cell: Dictionary = cell_variant
		var cell_rocks: Array = cell.get("rocks")
		var batch_start := 0
		while batch_start < cell_rocks.size():
			_add_rock_collision_body(
				rock_collision, cell.get("key") as Vector2i, cell_rocks, batch_start
			)
			batch_start += ROCK_COLLISION_MAX_SHAPES_PER_BODY
			work_items += 1
			if work_items >= chunks_per_frame:
				work_items = 0
				last_async_yields += 1
				await tree.process_frame
	root.add_child(rock_collision)
	_build_metadata(root)
	root.set_meta("async_build_yields", last_async_yields)
	return root


## Build collision for the nested layers **without overlap**.
##
## Naively adding one HeightMapShape3D per layer stacks three surfaces on top of
## one another wherever the tiers nest. A downward ray then hits whichever is
## highest, which is usually the coarsest — so a rover would drive on 2 m
## context geometry while standing inside a 0.02 m operational patch. That
## reproduced as a 2.18 m elevation disagreement in the round-trip test.
##
## Instead each layer contributes collision only where no finer layer covers it.
## Nesting is a containment chain (the sidecar's estimator enforces it), so each
## layer needs to exclude exactly one rectangle, leaving up to four bands:
##
##     +-----------------------------+
##     |          north band         |
##     +------+---------------+------+
##     | west |  (finer tier) | east |
##     +------+---------------+------+
##     |          south band         |
##     +-----------------------------+
func _build_collision(body: StaticBody3D) -> void:
	for spec_variant in _collision_chunk_specs():
		var spec: Dictionary = spec_variant
		_add_collision_chunk(
			body,
			spec.get("layer") as LayerData,
			int(spec.get("col0")),
			int(spec.get("row0")),
			int(spec.get("width")),
			int(spec.get("height")),
			String(spec.get("tag"))
		)


func _collision_region_specs() -> Array:
	var regions: Array = []
	# Coarsest first, so `layers_sorted[i + 1]` is the tier nested inside i.
	var sorted_layers := layers.duplicate()
	sorted_layers.sort_custom(func(a, b): return a.resolution_m > b.resolution_m)

	for i in sorted_layers.size():
		var layer: LayerData = sorted_layers[i]
		var child: LayerData = sorted_layers[i + 1] if i + 1 < sorted_layers.size() else null

		if child == null:
			regions.append({
				"layer": layer,
				"col0": 0,
				"row0": 0,
				"width": layer.width_samples,
				"height": layer.height_samples,
				"tag": "full",
			})
			continue

		# Child footprint in this layer's sample indices, clamped to the grid.
		var child_max_x := child.min_x + float(child.width_samples - 1) * child.resolution_m
		var child_max_z := child.min_z + float(child.height_samples - 1) * child.resolution_m
		var c0: int = clampi(int(floor((child.min_x - layer.min_x) / layer.resolution_m)), 0, layer.width_samples - 1)
		var c1: int = clampi(int(ceil((child_max_x - layer.min_x) / layer.resolution_m)), 0, layer.width_samples - 1)
		var r0: int = clampi(int(floor((child.min_z - layer.min_z) / layer.resolution_m)), 0, layer.height_samples - 1)
		var r1: int = clampi(int(ceil((child_max_z - layer.min_z) / layer.resolution_m)), 0, layer.height_samples - 1)

		# North band: rows above the child (row 0 is northernmost).
		if r0 >= 1:
			regions.append({
				"layer": layer,
				"col0": 0,
				"row0": 0,
				"width": layer.width_samples,
				"height": r0 + 1,
				"tag": "north",
			})
		# South band.
		if r1 <= layer.height_samples - 2:
			regions.append({
				"layer": layer,
				"col0": 0,
				"row0": r1,
				"width": layer.width_samples,
				"height": layer.height_samples - r1,
				"tag": "south",
			})
		# West band, spanning only the child's row range.
		if c0 >= 1:
			regions.append({
				"layer": layer,
				"col0": 0,
				"row0": r0,
				"width": c0 + 1,
				"height": r1 - r0 + 1,
				"tag": "west",
			})
		# East band.
		if c1 <= layer.width_samples - 2:
			regions.append({
				"layer": layer,
				"col0": c1,
				"row0": r0,
				"width": layer.width_samples - c1,
				"height": r1 - r0 + 1,
				"tag": "east",
			})
	return regions


func _collision_chunk_specs() -> Array:
	var chunks: Array = []
	for region_variant in _collision_region_specs():
		var region: Dictionary = region_variant
		var col0 := int(region.get("col0"))
		var row0 := int(region.get("row0"))
		var region_col_end := col0 + int(region.get("width")) - 1
		var region_row_end := row0 + int(region.get("height")) - 1
		if region_col_end <= col0 or region_row_end <= row0:
			continue
		var chunk_row0 := row0
		while chunk_row0 < region_row_end:
			var chunk_h := mini(
				COLLISION_CHUNK_QUADS + 1, region_row_end - chunk_row0 + 1
			)
			var chunk_col0 := col0
			while chunk_col0 < region_col_end:
				var chunk_w := mini(
					COLLISION_CHUNK_QUADS + 1, region_col_end - chunk_col0 + 1
				)
				chunks.append({
					"layer": region.get("layer"),
					"col0": chunk_col0,
					"row0": chunk_row0,
					"width": chunk_w,
					"height": chunk_h,
					"tag": region.get("tag"),
				})
				chunk_col0 += COLLISION_CHUNK_QUADS
			chunk_row0 += COLLISION_CHUNK_QUADS
	return chunks


func _add_collision_chunk(
	body: StaticBody3D, layer: LayerData, col0: int, row0: int, w: int, h: int, tag: String
) -> void:
	var shape := _make_collision_shape(layer, col0, row0, w, h)
	var node := CollisionShape3D.new()
	node.name = "%s_%s_c%06d_r%06d" % [_node_name_for_role(layer.role), tag, col0, row0]
	node.shape = shape
	# HeightMapShape3D spans one unit per sample and is centred on its own
	# origin, so the node carries the sample spacing as scale and the offset
	# back to this sub-rectangle's world centre as translation.
	node.scale = Vector3(layer.resolution_m, 1.0, layer.resolution_m)
	node.position = Vector3(
		layer.min_x + (float(col0) + float(w - 1) * 0.5) * layer.resolution_m,
		0.0,
		layer.min_z + (float(row0) + float(h - 1) * 0.5) * layer.resolution_m
	)
	node.set_meta("layer_id", layer.id)
	node.set_meta("col0", col0)
	node.set_meta("row0", row0)
	node.set_meta("width_samples", w)
	node.set_meta("height_samples", h)
	node.set_meta("min_x", layer.min_x + float(col0) * layer.resolution_m)
	node.set_meta("max_x", layer.min_x + float(col0 + w - 1) * layer.resolution_m)
	node.set_meta("min_z", layer.min_z + float(row0) * layer.resolution_m)
	node.set_meta("max_z", layer.min_z + float(row0 + h - 1) * layer.resolution_m)
	body.add_child(node)


func _make_collision_shape(
	layer: LayerData, col0: int, row0: int, w: int, h: int
) -> HeightMapShape3D:

	var sub := PackedFloat32Array()
	sub.resize(w * h)
	for r in h:
		var src := (row0 + r) * layer.width_samples + col0
		for c in w:
			sub[r * w + c] = layer.heights[src + c]

	var shape := HeightMapShape3D.new()
	shape.map_width = w
	shape.map_depth = h
	shape.map_data = sub
	return shape


func _node_name_for_role(role: String) -> String:
	match role:
		"context":
			return "ContextTerrain"
		"mission":
			return "MissionTerrain"
		"operational":
			return "OperationalTerrain"
		_:
			return "Terrain_%s" % role


## Collision heightfield. Godot expects row-major data with `map_width` columns.
func build_layer_shape(layer: LayerData) -> HeightMapShape3D:
	var shape := HeightMapShape3D.new()
	shape.map_width = layer.width_samples
	shape.map_depth = layer.height_samples
	shape.map_data = layer.heights
	return shape


## Backward-compatible whole-layer mesh helper. Scene construction uses
## deterministic chunks below so edits can update a bounded subset.
func build_layer_mesh(layer: LayerData) -> ArrayMesh:
	return _build_layer_region_mesh(
		layer,
		0,
		0,
		layer.width_samples,
		layer.height_samples,
		_far_visual_step(layer)
	)


func _build_visual_chunks(container: Node3D, layer: LayerData) -> void:
	var row0 := 0
	while row0 < layer.height_samples - 1:
		var h := mini(VISUAL_CHUNK_QUADS + 1, layer.height_samples - row0)
		var col0 := 0
		while col0 < layer.width_samples - 1:
			var w := mini(VISUAL_CHUNK_QUADS + 1, layer.width_samples - col0)
			_add_visual_chunk(container, layer, col0, row0, w, h)
			col0 += VISUAL_CHUNK_QUADS
		row0 += VISUAL_CHUNK_QUADS


func _add_visual_chunk(
	container: Node3D, layer: LayerData, col0: int, row0: int, w: int, h: int
) -> void:
	var step := _visual_step_for_region(layer, col0, row0, w, h)
	var node := MeshInstance3D.new()
	node.name = "chunk_c%06d_r%06d" % [col0, row0]
	node.mesh = _build_layer_region_mesh(layer, col0, row0, w, h, step)
	node.set_meta("layer_id", layer.id)
	node.set_meta("col0", col0)
	node.set_meta("row0", row0)
	node.set_meta("width_samples", w)
	node.set_meta("height_samples", h)
	node.set_meta("visual_step", step)
	node.set_meta("min_x", layer.min_x + float(col0) * layer.resolution_m)
	node.set_meta("max_x", layer.min_x + float(col0 + w - 1) * layer.resolution_m)
	node.set_meta("min_z", layer.min_z + float(row0) * layer.resolution_m)
	node.set_meta("max_z", layer.min_z + float(row0 + h - 1) * layer.resolution_m)
	container.add_child(node)


func _far_visual_step(layer: LayerData) -> int:
	return maxi(
		1,
		int(
			ceil(
				float(maxi(layer.width_samples, layer.height_samples))
				/ float(VISUAL_PREVIEW_MAX_SIDE)
			)
		)
	)


func _visual_step_for_region(
	layer: LayerData, col0: int, row0: int, w: int, h: int
) -> int:
	if _visual_focus_enabled and finest_layer_at(_visual_focus.x, _visual_focus.z) == layer:
		var min_x := layer.min_x + float(col0) * layer.resolution_m
		var max_x := layer.min_x + float(col0 + w - 1) * layer.resolution_m
		var min_z := layer.min_z + float(row0) * layer.resolution_m
		var max_z := layer.min_z + float(row0 + h - 1) * layer.resolution_m
		var nearest_x := clampf(_visual_focus.x, min_x, max_x)
		var nearest_z := clampf(_visual_focus.z, min_z, max_z)
		var dx := nearest_x - _visual_focus.x
		var dz := nearest_z - _visual_focus.z
		if dx * dx + dz * dz <= _visual_focus_radius_m * _visual_focus_radius_m:
			return 1
	return _far_visual_step(layer)


func _sample_indices(start: int, count: int, step: int) -> PackedInt32Array:
	var result := PackedInt32Array()
	var last := start + count - 1
	var value := start
	while value < last:
		result.append(value)
		value += step
	if result.is_empty() or result[result.size() - 1] != last:
		result.append(last)
	return result


## Visual region built directly from the heightfield. The v01-v10 diagonal
## matches Godot's HeightMapShape3D triangulation; both triangles retain +Y
## winding. Render and physics therefore describe the same focused surface.
func _build_layer_region_mesh(
	layer: LayerData, col0: int, row0: int, width: int, height: int, step: int
) -> ArrayMesh:
	var verts := PackedVector3Array()
	var normals := PackedVector3Array()
	var indices := PackedInt32Array()

	var sample_cols := _sample_indices(col0, width, step)
	var sample_rows := _sample_indices(row0, height, step)
	var w := sample_cols.size()
	var h := sample_rows.size()

	verts.resize(w * h)
	normals.resize(w * h)

	for r in h:
		for c in w:
			var gc := sample_cols[c]
			var gr := sample_rows[r]
			var y := layer.heights[gr * layer.width_samples + gc]
			verts[r * w + c] = Vector3(
				layer.min_x + float(gc) * layer.resolution_m,
				y,
				layer.min_z + float(gr) * layer.resolution_m
			)
			var hl := layer.heights[gr * layer.width_samples + maxi(gc - 1, 0)]
			var hr := layer.heights[gr * layer.width_samples + mini(gc + 1, layer.width_samples - 1)]
			var hd := layer.heights[maxi(gr - 1, 0) * layer.width_samples + gc]
			var hu := layer.heights[mini(gr + 1, layer.height_samples - 1) * layer.width_samples + gc]
			var nx := -(hr - hl) / (2.0 * layer.resolution_m)
			var nz := -(hu - hd) / (2.0 * layer.resolution_m)
			normals[r * w + c] = Vector3(nx, 1.0, nz).normalized()

	for r in h - 1:
		for c in w - 1:
			var i00 := r * w + c
			var i10 := r * w + c + 1
			var i01 := (r + 1) * w + c
			var i11 := (r + 1) * w + c + 1
			# Godot renders clockwise-wound triangles as front faces. Seen from
			# +Y with north (-Z) up, (col, row) -> (col+1, row) -> (col, row+1) is
			# clockwise, so both triangles face upward and survive back-face
			# culling under the default material.
			indices.append_array([i00, i10, i01, i10, i11, i01])

	var arrays := []
	arrays.resize(Mesh.ARRAY_MAX)
	arrays[Mesh.ARRAY_VERTEX] = verts
	arrays[Mesh.ARRAY_NORMAL] = normals
	arrays[Mesh.ARRAY_INDEX] = indices

	var mesh := ArrayMesh.new()
	mesh.add_surface_from_arrays(Mesh.PRIMITIVE_TRIANGLES, arrays)
	return mesh


func _build_rocks(root: Node3D) -> void:
	var physical: Array = []
	var visual: Array = []
	for rock_variant in _rocks:
		var rock: Dictionary = rock_variant
		if bool(rock.get("physical", false)):
			physical.append(rock)
		else:
			visual.append(rock)

	root.add_child(_make_rock_multimesh("PhysicalRocks", physical))
	root.add_child(_make_rock_multimesh("VisualRocks", visual))
	root.add_child(_make_rock_collision(physical))


func _make_rock_multimesh(node_name: String, rocks: Array) -> MultiMeshInstance3D:
	var node := _new_rock_multimesh(node_name, rocks.size())
	for i in rocks.size():
		_set_rock_instance(node.multimesh, i, rocks[i])
	return node


func _new_rock_multimesh(node_name: String, instance_count: int) -> MultiMeshInstance3D:
	var node := MultiMeshInstance3D.new()
	node.name = node_name

	var mm := MultiMesh.new()
	mm.transform_format = MultiMesh.TRANSFORM_3D
	var sphere := SphereMesh.new()
	sphere.radius = 1.0
	sphere.height = 2.0
	sphere.radial_segments = 8
	sphere.rings = 4
	mm.mesh = sphere
	mm.instance_count = instance_count
	node.multimesh = mm
	return node


func _set_rock_instance(mm: MultiMesh, index: int, rock: Dictionary) -> void:
	var p: Array = rock.get("position_m", [0, 0, 0])
	var s: Array = rock.get("scale_m", [1, 1, 1])
	var q: Array = rock.get("rotation_quaternion", [0, 0, 0, 1])
	var rotation := Quaternion(float(q[0]), float(q[1]), float(q[2]), float(q[3])).normalized()
	var basis := rock_instance_basis(rotation, Vector3(float(s[0]), float(s[1]), float(s[2])))
	mm.set_instance_transform(
		index, Transform3D(basis, Vector3(float(p[0]), float(p[1]), float(p[2])))
	)


## Basis of one rendered rock instance from its rotation and ellipsoid semi-axes.
## The semi-axes are local (rock frame): scale first, then rotate, matching
## the collision ellipsoid in _add_rock_collision_shape and the browser
## viewer's T*R*S composition. Basis.scaled() would scale along world axes.
func rock_instance_basis(rotation: Quaternion, scale: Vector3) -> Basis:
	return Basis(rotation).scaled_local(scale)


func _make_rock_collision(physical: Array) -> Node3D:
	var root := Node3D.new()
	root.name = "PhysicalRockCollision"
	for cell_variant in _rock_collision_cells(physical):
		var cell: Dictionary = cell_variant
		var key: Vector2i = cell.get("key")
		var cell_rocks: Array = cell.get("rocks")
		var batch_start := 0
		while batch_start < cell_rocks.size():
			_add_rock_collision_body(root, key, cell_rocks, batch_start)
			batch_start += ROCK_COLLISION_MAX_SHAPES_PER_BODY
	return root


func _rock_collision_cells(physical: Array) -> Array:
	# Spatial cells bound broadphase updates; batches cap the number of shapes
	# owned by any one physics body even when a dense rock field falls in one
	# cell. Input order within a cell remains the deterministic export order.
	var cells: Dictionary = {}
	for rock_variant in physical:
		var rock: Dictionary = rock_variant
		var p: Array = rock.get("position_m")
		var key := Vector2i(
			floori(float(p[0]) / ROCK_COLLISION_CELL_METERS),
			floori(float(p[2]) / ROCK_COLLISION_CELL_METERS)
		)
		if not cells.has(key):
			cells[key] = []
		(cells[key] as Array).append(rock)

	var cell_keys := cells.keys()
	cell_keys.sort_custom(
		func(a: Vector2i, b: Vector2i):
			return a.x < b.x if a.y == b.y else a.y < b.y
	)
	var ordered: Array = []
	for key_variant in cell_keys:
		var key: Vector2i = key_variant
		ordered.append({"key": key, "rocks": cells[key]})
	return ordered


func _add_rock_collision_body(
	root: Node3D, key: Vector2i, cell_rocks: Array, batch_start: int
) -> StaticBody3D:
	var body := StaticBody3D.new()
	body.name = "cell_x%d_z%d_batch%03d" % [
		key.x,
		key.y,
		batch_start / ROCK_COLLISION_MAX_SHAPES_PER_BODY,
	]
	body.collision_layer = ROCK_COLLISION_LAYER
	body.collision_mask = 0
	body.set_meta("cell_x", key.x)
	body.set_meta("cell_z", key.y)
	root.add_child(body)
	var batch_end := mini(
		batch_start + ROCK_COLLISION_MAX_SHAPES_PER_BODY, cell_rocks.size()
	)
	for i in range(batch_start, batch_end):
		_add_rock_collision_shape(body, cell_rocks[i], i)
	return body


func _add_rock_collision_shape(body: StaticBody3D, rock: Dictionary, index: int) -> void:
	var p: Array = rock.get("position_m")
	var s: Array = rock.get("scale_m")
	var q: Array = rock.get("rotation_quaternion")
	var sx := float(s[0])
	var sy := float(s[1])
	var sz := float(s[2])

	# A deterministic 26-point convex ellipsoid follows the same transform and
	# dimensions as the low-poly SphereMesh visual without unsupported non-uniform
	# CollisionShape3D scaling.
	var points := PackedVector3Array([Vector3(0.0, sy, 0.0), Vector3(0.0, -sy, 0.0)])
	for ring_y in [-0.55, 0.0, 0.55]:
		var ring_radius: float = sqrt(1.0 - float(ring_y) * float(ring_y))
		for segment in 8:
			var angle := TAU * float(segment) / 8.0
			points.append(
				Vector3(cos(angle) * sx * ring_radius, float(ring_y) * sy, sin(angle) * sz * ring_radius)
			)
	var shape := ConvexPolygonShape3D.new()
	shape.points = points

	var node := CollisionShape3D.new()
	node.name = "rock_%06d" % index
	node.shape = shape
	node.position = Vector3(float(p[0]), float(p[1]), float(p[2]))
	node.quaternion = Quaternion(float(q[0]), float(q[1]), float(q[2]), float(q[3])).normalized()
	node.set_meta("rock_id", rock.get("id", ""))
	body.add_child(node)


## Replace file-loaded rock instances with a complete terrain.getRocks result.
## Truncated preview responses are refused because partial collision would be
## indistinguishable from a complete physical world.
func replace_rocks(root: Node3D, rocks_payload: Dictionary) -> Dictionary:
	var validated := _validate_rocks_payload(rocks_payload, true)
	if not bool(validated.get("ok", false)):
		return validated
	var next_rocks: Array = validated.get("rocks", [])
	var physical: Array = []
	var visual: Array = []
	for rock_variant in next_rocks:
		var rock: Dictionary = rock_variant
		if bool(rock.get("physical", false)):
			physical.append(rock)
		else:
			visual.append(rock)

	# Construct the complete replacement before touching the live scene.
	var next_physical := _make_rock_multimesh("PhysicalRocks", physical)
	var next_visual := _make_rock_multimesh("VisualRocks", visual)
	var next_collision := _make_rock_collision(physical)
	for node_name in ["PhysicalRocks", "VisualRocks", "PhysicalRockCollision"]:
		var old := root.get_node_or_null(node_name)
		if old != null:
			root.remove_child(old)
			old.free()
	root.add_child(next_physical)
	root.add_child(next_visual)
	root.add_child(next_collision)
	_rocks = next_rocks
	return {
		"ok": true,
		"rocks": next_rocks.size(),
		"physical_rocks": physical.size(),
		"visual_rocks": visual.size(),
		"collision_bodies": next_collision.get_child_count(),
	}


func _build_metadata(root: Node3D) -> void:
	var node := Node.new()
	node.name = "TerrainMetadata"
	node.set_meta("terrain_id", manifest.get("terrainId", ""))
	node.set_meta("seed", manifest.get("seed", ""))
	node.set_meta("coordinate_system", manifest.get("coordinate_system", {}))
	node.set_meta("origin", manifest.get("origin", {}))
	node.set_meta("solar", manifest.get("solar", {}))
	node.set_meta("provenance", manifest.get("provenance", {}))
	var layer_metadata: Array = []
	for layer in layers:
		layer_metadata.append({
			"id": layer.id,
			"role": layer.role,
			"elevation_provenance": _manifest_layer_value(layer.id, "elevation_provenance"),
			"semantic_classes": Array(layer.semantic_classes),
			"elevation_source_values": Array(layer.elevation_source_values),
		})
	node.set_meta("layers", layer_metadata)
	node.set_meta("visual_focus_enabled", _visual_focus_enabled)
	if _visual_focus_enabled:
		node.set_meta("visual_focus", _visual_focus)
		node.set_meta("visual_focus_radius_m", _visual_focus_radius_m)
	root.add_child(node)


func _manifest_layer_value(layer_id: String, key: String) -> Variant:
	for layer_variant in manifest.get("layers", []):
		if typeof(layer_variant) == TYPE_DICTIONARY:
			var layer_manifest: Dictionary = layer_variant
			if layer_manifest.get("id", "") == layer_id:
				return layer_manifest.get(key)
	return null


func _layer_by_id(layer_id: String) -> LayerData:
	for layer in layers:
		if layer.id == layer_id:
			return layer
	return null


func _sync_error(message: String) -> Dictionary:
	return {"ok": false, "error": message}


func _decode_base64_exact(value: Variant, expected_bytes: int, label: String) -> Dictionary:
	if typeof(value) != TYPE_STRING:
		return _sync_error("%s must be a base64 string" % label)
	var encoded := String(value)
	var bytes := Marshalls.base64_to_raw(encoded)
	if bytes.is_empty() and not encoded.is_empty():
		return _sync_error("%s is not canonical base64" % label)
	if not bytes.is_empty() and Marshalls.raw_to_base64(bytes) != encoded:
		return _sync_error("%s is not canonical base64" % label)
	if bytes.size() != expected_bytes:
		return _sync_error(
			"%s decoded to %d bytes; expected %d" % [label, bytes.size(), expected_bytes]
		)
	return {"ok": true, "bytes": bytes}


func _sample_count(value: Variant, label: String) -> Dictionary:
	if not _nonnegative_integer(value):
		return _sync_error("%s must be a non-negative integer" % label)
	var count := int(value)
	if count > MAX_SPARSE_SAMPLES:
		return _sync_error("%s exceeds the %d-sample sparse limit" % [label, MAX_SPARSE_SAMPLES])
	return {"ok": true, "count": count}
func _validate_sparse_indices(
	layer: LayerData, indices: PackedInt32Array, sample_count: int
) -> Dictionary:
	if indices.size() != sample_count:
		return _sync_error("sparse indices count does not match sampleCount")
	if sample_count == 0:
		return {"ok": true, "bounds": {}}
	var min_col := layer.width_samples
	var min_row := layer.height_samples
	var max_col := -1
	var max_row := -1
	var previous := -1
	for index in indices:
		if index < 0 or index >= layer.heights.size():
			return _sync_error("sparse sample index %d is outside layer '%s'" % [index, layer.id])
		if index <= previous:
			return _sync_error("sparse sample indices must be strictly increasing")
		previous = index
		var col := index % layer.width_samples
		var row: int = index / layer.width_samples
		min_col = mini(min_col, col)
		min_row = mini(min_row, row)
		max_col = maxi(max_col, col)
		max_row = maxi(max_row, row)
	return {
		"ok": true,
		"bounds": {
			"minX": layer.min_x + float(min_col) * layer.resolution_m,
			"minZ": layer.min_z + float(min_row) * layer.resolution_m,
			"maxX": layer.min_x + float(max_col) * layer.resolution_m,
			"maxZ": layer.min_z + float(max_row) * layer.resolution_m,
		},
	}


## Apply the exact little-endian sparse height payload from TerrainDelta.
## Validation completes before the first sample is mutated.
func apply_sparse_delta(sparse: Dictionary) -> Dictionary:
	var layer_id := String(sparse.get("layerId", ""))
	var layer := _layer_by_id(layer_id)
	if layer == null:
		return _sync_error("no loaded layer '%s'" % layer_id)
	var count_result := _sample_count(sparse.get("sampleCount"), "sampleCount")
	if not bool(count_result.get("ok", false)):
		return count_result
	var count := int(count_result.get("count"))
	var indices_result := _decode_base64_exact(sparse.get("indices"), count * 4, "indices")
	if not bool(indices_result.get("ok", false)):
		return indices_result
	var heights_result := _decode_base64_exact(sparse.get("heights"), count * 4, "heights")
	if not bool(heights_result.get("ok", false)):
		return heights_result
	var indices: PackedInt32Array = (indices_result.get("bytes") as PackedByteArray).to_int32_array()
	var heights: PackedFloat32Array = (heights_result.get("bytes") as PackedByteArray).to_float32_array()
	var index_validation := _validate_sparse_indices(layer, indices, count)
	if not bool(index_validation.get("ok", false)):
		return index_validation
	for height in heights:
		if not is_finite(height):
			return _sync_error("sparse heights contain NaN or infinity")

	for i in count:
		layer.heights[indices[i]] = heights[i]
	return {
		"ok": true,
		"layer_id": layer.id,
		"changed_samples": count,
		"changed_bounds": index_validation.get("bounds"),
	}


## Optional semantic-mask companion to apply_sparse_delta. The live protocol
## may omit it; a caller only invokes this when maskSparse is present.
func apply_mask_sparse(mask_sparse: Dictionary) -> Dictionary:
	var layer_id := String(mask_sparse.get("layerId", ""))
	var layer := _layer_by_id(layer_id)
	if layer == null:
		return _sync_error("no loaded layer '%s'" % layer_id)
	if layer.semantic.is_empty() or layer.semantic_classes.is_empty():
		return _sync_error("layer '%s' has no loaded semantic mask" % layer_id)
	var count_result := _sample_count(mask_sparse.get("sampleCount"), "sampleCount")
	if not bool(count_result.get("ok", false)):
		return count_result
	var count := int(count_result.get("count"))
	var indices_result := _decode_base64_exact(mask_sparse.get("indices"), count * 4, "indices")
	if not bool(indices_result.get("ok", false)):
		return indices_result
	var values_result := _decode_base64_exact(mask_sparse.get("values"), count, "values")
	if not bool(values_result.get("ok", false)):
		return values_result
	var indices: PackedInt32Array = (indices_result.get("bytes") as PackedByteArray).to_int32_array()
	var values: PackedByteArray = values_result.get("bytes")
	var index_validation := _validate_sparse_indices(layer, indices, count)
	if not bool(index_validation.get("ok", false)):
		return index_validation
	for value in values:
		if int(value) >= layer.semantic_classes.size():
			return _sync_error("mask sparse payload contains an undeclared semantic class index")
	for i in count:
		layer.semantic[indices[i]] = values[i]
	return {
		"ok": true,
		"layer_id": layer.id,
		"changed_samples": count,
		"changed_bounds": index_validation.get("bounds"),
	}


func _validated_world_bounds(bounds: Dictionary) -> Dictionary:
	for key in ["minX", "minZ", "maxX", "maxZ"]:
		if not _finite_number(bounds.get(key)):
			return _sync_error("changed bounds '%s' must be finite" % key)
	var min_x := float(bounds.get("minX"))
	var min_z := float(bounds.get("minZ"))
	var max_x := float(bounds.get("maxX"))
	var max_z := float(bounds.get("maxZ"))
	if max_x < min_x or max_z < min_z:
		return _sync_error("changed bounds must be ordered")
	return {
		"ok": true,
		"bounds": {"minX": min_x, "minZ": min_z, "maxX": max_x, "maxZ": max_z},
	}


## Smallest stride-1 terrain.getTile request covering world-space bounds.
func tile_request_for_bounds(layer_id: String, bounds: Dictionary) -> Dictionary:
	var layer := _layer_by_id(layer_id)
	if layer == null:
		return _sync_error("no loaded layer '%s'" % layer_id)
	var validated := _validated_world_bounds(bounds)
	if not bool(validated.get("ok", false)):
		return validated
	var b: Dictionary = validated.get("bounds")
	if (
		float(b.get("maxX")) < layer.min_x
		or float(b.get("minX")) > layer.max_x
		or float(b.get("maxZ")) < layer.min_z
		or float(b.get("minZ")) > layer.max_z
	):
		return _sync_error("changed bounds do not intersect layer '%s'" % layer_id)
	var clipped_min_x := clampf(float(b.get("minX")), layer.min_x, layer.max_x)
	var clipped_min_z := clampf(float(b.get("minZ")), layer.min_z, layer.max_z)
	var clipped_max_x := clampf(float(b.get("maxX")), layer.min_x, layer.max_x)
	var clipped_max_z := clampf(float(b.get("maxZ")), layer.min_z, layer.max_z)
	var col0 := int(floor((clipped_min_x - layer.min_x) / layer.resolution_m))
	var row0 := int(floor((clipped_min_z - layer.min_z) / layer.resolution_m))
	var col1 := clampi(
		int(ceil((clipped_max_x - layer.min_x) / layer.resolution_m)),
		col0,
		layer.width_samples - 1
	)
	var row1 := clampi(
		int(ceil((clipped_max_z - layer.min_z) / layer.resolution_m)),
		row0,
		layer.height_samples - 1
	)
	return {
		"ok": true,
		"layerId": layer.id,
		"col0": col0,
		"row0": row0,
		"width": col1 - col0 + 1,
		"height": row1 - row0 + 1,
		"stride": 1,
	}


## Apply a stride-1 terrain.getTile result. All dimensions and values are
## validated before the in-memory heightfield is changed.
func apply_tile_payload(payload: Dictionary) -> Dictionary:
	var layer_id := String(payload.get("layerId", ""))
	var layer := _layer_by_id(layer_id)
	if layer == null:
		return _sync_error("no loaded layer '%s'" % layer_id)
	if String(payload.get("channel", "height")) != "height":
		return _sync_error("height tile payload channel must be 'height'")
	if payload.get("encoding", "") != "base64:float32le":
		return _sync_error("tile encoding must be base64:float32le")
	if int(payload.get("stride", 0)) != 1:
		return _sync_error("simulation tile payload must have stride 1")
	for key in ["col0", "row0", "width", "height"]:
		if not _positive_integer(payload.get(key)) and key not in ["col0", "row0"]:
			return _sync_error("tile '%s' must be a positive integer" % key)
		if key in ["col0", "row0"]:
			var value: Variant = payload.get(key)
			if not _finite_number(value) or float(value) < 0.0 or float(value) != floor(float(value)):
				return _sync_error("tile '%s' must be a non-negative integer" % key)
	if (
		float(payload.get("col0")) > float(layer.width_samples - 1)
		or float(payload.get("row0")) > float(layer.height_samples - 1)
		or float(payload.get("width")) > float(layer.width_samples) - float(payload.get("col0"))
		or float(payload.get("height")) > float(layer.height_samples) - float(payload.get("row0"))
	):
		return _sync_error("tile payload exceeds layer '%s' bounds" % layer_id)
	var col0 := int(payload.get("col0"))
	var row0 := int(payload.get("row0"))
	var width := int(payload.get("width"))
	var height := int(payload.get("height"))
	if not _finite_number(payload.get("layerResolutionMeters")):
		return _sync_error("tile layerResolutionMeters must be finite")
	if not is_equal_approx(float(payload.get("layerResolutionMeters")), layer.resolution_m):
		return _sync_error("tile layerResolutionMeters does not match loaded layer")
	if (
		not _finite_number(payload.get("resolutionMeters"))
		or not is_equal_approx(float(payload.get("resolutionMeters")), layer.resolution_m)
	):
		return _sync_error("stride-1 tile resolutionMeters does not match loaded layer")
	var count := width * height
	var data_result := _decode_base64_exact(payload.get("data"), count * 4, "tile data")
	if not bool(data_result.get("ok", false)):
		return data_result
	var heights: PackedFloat32Array = (data_result.get("bytes") as PackedByteArray).to_float32_array()
	for value in heights:
		if not is_finite(value):
			return _sync_error("tile heights contain NaN or infinity")
	for row in height:
		var dst := (row0 + row) * layer.width_samples + col0
		var src := row * width
		for col in width:
			layer.heights[dst + col] = heights[src + col]
	return {
		"ok": true,
		"layer_id": layer.id,
		"changed_samples": count,
		"changed_bounds": {
			"minX": layer.min_x + float(col0) * layer.resolution_m,
			"minZ": layer.min_z + float(row0) * layer.resolution_m,
			"maxX": layer.min_x + float(col0 + width - 1) * layer.resolution_m,
			"maxZ": layer.min_z + float(row0 + height - 1) * layer.resolution_m,
		},
	}


## Apply a stride-1 semantic-channel terrain.getTile result for oversized mask
## edits whose sparse payload was deliberately omitted.
func apply_mask_tile_payload(payload: Dictionary) -> Dictionary:
	var layer_id := String(payload.get("layerId", ""))
	var layer := _layer_by_id(layer_id)
	if layer == null:
		return _sync_error("no loaded layer '%s'" % layer_id)
	if layer.semantic.is_empty() or layer.semantic_classes.is_empty():
		return _sync_error("layer '%s' has no loaded semantic mask" % layer_id)
	if payload.get("channel", "") != "semantic":
		return _sync_error("mask tile payload channel must be 'semantic'")
	if payload.get("encoding", "") != "base64:uint8":
		return _sync_error("mask tile encoding must be base64:uint8")
	if int(payload.get("stride", 0)) != 1:
		return _sync_error("simulation mask tile payload must have stride 1")
	for key in ["col0", "row0", "width", "height"]:
		if not _positive_integer(payload.get(key)) and key not in ["col0", "row0"]:
			return _sync_error("mask tile '%s' must be a positive integer" % key)
		if key in ["col0", "row0"]:
			var value: Variant = payload.get(key)
			if not _finite_number(value) or float(value) < 0.0 or float(value) != floor(float(value)):
				return _sync_error("mask tile '%s' must be a non-negative integer" % key)
	if (
		float(payload.get("col0")) > float(layer.width_samples - 1)
		or float(payload.get("row0")) > float(layer.height_samples - 1)
		or float(payload.get("width")) > float(layer.width_samples) - float(payload.get("col0"))
		or float(payload.get("height")) > float(layer.height_samples) - float(payload.get("row0"))
	):
		return _sync_error("mask tile payload exceeds layer '%s' bounds" % layer_id)
	var col0 := int(payload.get("col0"))
	var row0 := int(payload.get("row0"))
	var width := int(payload.get("width"))
	var height := int(payload.get("height"))
	if (
		not _finite_number(payload.get("layerResolutionMeters"))
		or not is_equal_approx(float(payload.get("layerResolutionMeters")), layer.resolution_m)
	):
		return _sync_error("mask tile layerResolutionMeters does not match loaded layer")
	if (
		not _finite_number(payload.get("resolutionMeters"))
		or not is_equal_approx(float(payload.get("resolutionMeters")), layer.resolution_m)
	):
		return _sync_error("stride-1 mask tile resolutionMeters does not match loaded layer")
	var count := width * height
	var data_result := _decode_base64_exact(payload.get("data"), count, "mask tile data")
	if not bool(data_result.get("ok", false)):
		return data_result
	var values: PackedByteArray = data_result.get("bytes")
	for value in values:
		if int(value) >= layer.semantic_classes.size():
			return _sync_error("mask tile contains an undeclared semantic class index")
	for row in height:
		var dst := (row0 + row) * layer.width_samples + col0
		var src := row * width
		for col in width:
			layer.semantic[dst + col] = values[src + col]
	return {
		"ok": true,
		"layer_id": layer.id,
		"changed_samples": count,
		"changed_bounds": {
			"minX": layer.min_x + float(col0) * layer.resolution_m,
			"minZ": layer.min_z + float(row0) * layer.resolution_m,
			"maxX": layer.min_x + float(col0 + width - 1) * layer.resolution_m,
			"maxZ": layer.min_z + float(row0 + height - 1) * layer.resolution_m,
		},
	}


func _node_intersects_bounds(node: Node, bounds: Dictionary, expand_m: float) -> bool:
	return not (
		float(node.get_meta("max_x")) < float(bounds.get("minX")) - expand_m
		or float(node.get_meta("min_x")) > float(bounds.get("maxX")) + expand_m
		or float(node.get_meta("max_z")) < float(bounds.get("minZ")) - expand_m
		or float(node.get_meta("min_z")) > float(bounds.get("maxZ")) + expand_m
	)


func _has_chunk_metadata(node: Node) -> bool:
	for key in [
		"layer_id",
		"col0",
		"row0",
		"width_samples",
		"height_samples",
		"min_x",
		"max_x",
		"min_z",
		"max_z",
	]:
		if not node.has_meta(key):
			return false
	return true


## Rebuild only render/collision chunks intersecting changed world bounds. One
## sample of padding covers normals that read immediate neighbours.
func refresh_changed_bounds(
	root: Node3D, layer_id: String, bounds: Dictionary
) -> Dictionary:
	var layer := _layer_by_id(layer_id)
	if layer == null:
		return _sync_error("no loaded layer '%s'" % layer_id)
	var validated := _validated_world_bounds(bounds)
	if not bool(validated.get("ok", false)):
		return validated
	var b: Dictionary = validated.get("bounds")
	if (
		float(b.get("maxX")) < layer.min_x
		or float(b.get("minX")) > layer.max_x
		or float(b.get("maxZ")) < layer.min_z
		or float(b.get("minZ")) > layer.max_z
	):
		return _sync_error("changed bounds do not intersect layer '%s'" % layer_id)
	var layer_container: Node3D = null
	for child in root.get_children():
		if child is Node3D and String(child.get_meta("layer_id", "")) == layer_id:
			layer_container = child
			break
	if layer_container == null:
		return _sync_error("scene has no visual container for layer '%s'" % layer_id)
	var collision_parent := root.get_node_or_null("TerrainCollision")
	if collision_parent == null:
		return _sync_error("scene has no TerrainCollision node")

	# Resolve and type-check every target before mutating either render or
	# physics state, so a malformed scene cannot leave a half-refreshed terrain.
	var visual_targets: Array[MeshInstance3D] = []
	for child in layer_container.get_children():
		if not child.has_meta("visual_step"):
			continue
		if not (child is MeshInstance3D) or not _has_chunk_metadata(child):
			return _sync_error("scene has malformed visual chunks for layer '%s'" % layer_id)
		if int(child.get_meta("visual_step")) < 1:
			return _sync_error("scene has an invalid visual stride for layer '%s'" % layer_id)
		if _node_intersects_bounds(child, b, layer.resolution_m):
			visual_targets.append(child as MeshInstance3D)
	var collision_targets: Array[CollisionShape3D] = []
	for child in collision_parent.get_children():
		if String(child.get_meta("layer_id", "")) != layer_id:
			continue
		if not (child is CollisionShape3D) or not _has_chunk_metadata(child):
			return _sync_error("scene has malformed collision chunks for layer '%s'" % layer_id)
		if _node_intersects_bounds(child, b, layer.resolution_m):
			collision_targets.append(child as CollisionShape3D)

	for mesh_node in visual_targets:
		var child: MeshInstance3D = mesh_node
		mesh_node.mesh = _build_layer_region_mesh(
			layer,
			int(child.get_meta("col0")),
			int(child.get_meta("row0")),
			int(child.get_meta("width_samples")),
			int(child.get_meta("height_samples")),
			int(child.get_meta("visual_step"))
		)
	for collision_node in collision_targets:
		var child: CollisionShape3D = collision_node
		collision_node.shape = _make_collision_shape(
			layer,
			int(child.get_meta("col0")),
			int(child.get_meta("row0")),
			int(child.get_meta("width_samples")),
			int(child.get_meta("height_samples"))
		)
	return {
		"ok": true,
		"layer_id": layer.id,
		"visual_chunks": visual_targets.size(),
		"collision_chunks": collision_targets.size(),
	}


## Finest layer covering a world position — the sidecar's `elevationAt` rule,
## so both sides agree on which tier is authoritative.
func finest_layer_at(x: float, z: float) -> LayerData:
	if not is_finite(x) or not is_finite(z):
		return null
	var best: LayerData = null
	for layer in layers:
		if x < layer.min_x or x > layer.max_x or z < layer.min_z or z > layer.max_z:
			continue
		if best == null or layer.resolution_m < best.resolution_m:
			best = layer
	return best


## Elevation from the finest covering layer.
func elevation_at(x: float, z: float) -> float:
	var layer := finest_layer_at(x, z)
	if layer == null:
		return NAN
	return layer.height_at(x, z)
