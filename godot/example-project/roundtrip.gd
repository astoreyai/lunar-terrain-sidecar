extends SceneTree
## Godot-side half of the round-trip acceptance test (spec §26, §31).
##
## Reads an export produced by the sidecar, builds terrain + collision, then
## **raycasts against the real collision geometry** at probe points the sidecar
## supplied along with its own elevation answers, and writes the comparison out
## as JSON.
##
## Raycasting rather than re-reading the heightfield is the point: it exercises
## the actual physics representation Godot will drive a rover against, so a
## scale error, an axis swap, a centring mistake in HeightMapShape3D or an
## inverted winding all surface as a numerical disagreement.
##
## Usage:
##   godot --headless --path godot/example-project --script roundtrip.gd -- \
##         --export-dir <dir> --probes <probes.json> --out <result.json>

const LunarTerrainLoaderScript := preload("res://addons/lunar_terrain/lunar_terrain_loader.gd")

var _export_dir: String = ""
var _probes_path: String = ""
var _out_path: String = ""
var _loader: RefCounted = null
var _root: Node3D = null
var _frames: int = 0


func _initialize() -> void:
	var args := OS.get_cmdline_user_args()
	for i in args.size():
		match args[i]:
			"--export-dir":
				_export_dir = args[i + 1]
			"--probes":
				_probes_path = args[i + 1]
			"--out":
				_out_path = args[i + 1]

	if _export_dir.is_empty() or _probes_path.is_empty() or _out_path.is_empty():
		push_error("usage: --export-dir <dir> --probes <file> --out <file>")
		quit(2)
		return

	_loader = LunarTerrainLoaderScript.new()
	if not _loader.load_export(_export_dir):
		_write_failure("load_failed", _loader.errors)
		quit(1)
		return

	_root = _loader.build_scene(root)
	print("loaded %d layers from %s" % [_loader.layers.size(), _export_dir])


func _process(_delta: float) -> bool:
	# Give the physics server a couple of frames to register the static bodies
	# before raycasting; querying on frame 0 returns no hits.
	_frames += 1
	if _frames < 3:
		return false
	_run_checks()
	return true


func _run_checks() -> void:
	var probes_text := FileAccess.get_file_as_string(_probes_path)
	var parsed: Variant = JSON.parse_string(probes_text)
	if typeof(parsed) != TYPE_DICTIONARY:
		_write_failure("probes_unreadable", ["could not parse %s" % _probes_path])
		quit(1)
		return

	var probes: Array = (parsed as Dictionary).get("probes", [])
	var space := _root.get_world_3d().direct_space_state

	var results: Array = []
	var max_abs_error := 0.0
	var max_on_grid_error := 0.0
	var max_off_grid_error := 0.0
	var max_normal_error := 0.0
	var missed := 0

	for probe_variant in probes:
		var probe: Dictionary = probe_variant
		var x := float(probe["x"])
		var z := float(probe["z"])
		var expected := float(probe["elevation_m"])
		var on_grid := bool(probe.get("on_grid", false))

		# Cast straight down from well above the terrain.
		var from := Vector3(x, expected + 50.0, z)
		var to := Vector3(x, expected - 50.0, z)
		var query := PhysicsRayQueryParameters3D.create(from, to)
		query.collide_with_areas = false
		query.collide_with_bodies = true
		var hit := space.intersect_ray(query)

		var entry := {"x": x, "z": z, "expected_m": expected, "on_grid": on_grid}
		if hit.is_empty():
			# Diagnose rather than just counting: retry from far above with a
			# much longer ray, which distinguishes "no collider here at all"
			# from "the 100 m ray was too short or started inside geometry".
			var wide := PhysicsRayQueryParameters3D.create(
				Vector3(x, 5000.0, z), Vector3(x, -5000.0, z)
			)
			var retry := space.intersect_ray(wide)
			missed += 1
			entry["hit"] = false
			entry["retry_hit"] = not retry.is_empty()
			if not retry.is_empty():
				entry["retry_y"] = float((retry["position"] as Vector3).y)
				entry["retry_collider"] = str((retry["collider"] as Node).name)
			results.append(entry)
			continue

		var hit_y := float((hit["position"] as Vector3).y)
		var normal: Vector3 = hit["normal"]
		var err: float = absf(hit_y - expected)
		max_abs_error = maxf(max_abs_error, err)
		if on_grid:
			max_on_grid_error = maxf(max_on_grid_error, err)
		else:
			max_off_grid_error = maxf(max_off_grid_error, err)
		# Ground normals must point up; a flipped winding would give normal.y < 0.
		max_normal_error = maxf(max_normal_error, 1.0 - normal.y)

		entry["hit"] = true
		entry["godot_m"] = hit_y
		entry["error_m"] = hit_y - expected
		entry["normal_y"] = normal.y
		results.append(entry)

	# Independently, check the loader's own bilinear read against the sidecar,
	# which isolates a file-parsing error from a physics-scale error.
	var max_sample_error := 0.0
	for probe_variant in probes:
		var probe: Dictionary = probe_variant
		var h: float = _loader.elevation_at(float(probe["x"]), float(probe["z"]))
		if is_nan(h):
			continue
		max_sample_error = maxf(max_sample_error, absf(h - float(probe["elevation_m"])))

	var metadata: Node = _root.get_node("TerrainMetadata")
	var report := {
		"ok": missed == 0,
		"probes": probes.size(),
		"missed": missed,
		"max_abs_error_m": max_abs_error,
		"max_on_grid_error_m": max_on_grid_error,
		"max_off_grid_error_m": max_off_grid_error,
		"max_sample_error_m": max_sample_error,
		"max_normal_deviation": max_normal_error,
		"layers": _loader.layers.size(),
		"terrain_id": metadata.get_meta("terrain_id"),
		"seed": metadata.get_meta("seed"),
		"coordinate_system": metadata.get_meta("coordinate_system"),
		"collision_shapes": _root.get_node("TerrainCollision").get_child_count(),
		"physical_rocks": _root.get_node("PhysicalRocks").multimesh.instance_count,
		"visual_rocks": _root.get_node("VisualRocks").multimesh.instance_count,
		"godot_version": Engine.get_version_info(),
		"results": results,
	}

	var f := FileAccess.open(_out_path, FileAccess.WRITE)
	if f == null:
		push_error("cannot write %s" % _out_path)
		quit(1)
		return
	f.store_string(JSON.stringify(report, "  "))
	f.close()

	print("probes=%d missed=%d max_collision_error=%.6f m max_sample_error=%.6f m"
		% [probes.size(), missed, max_abs_error, max_sample_error])
	quit(0)


func _write_failure(reason: String, details) -> void:
	var f := FileAccess.open(_out_path, FileAccess.WRITE)
	if f != null:
		f.store_string(JSON.stringify({"ok": false, "reason": reason, "details": details}, "  "))
		f.close()
	push_error("%s: %s" % [reason, details])
