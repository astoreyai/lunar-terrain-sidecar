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
var _async_build := false
var _loader: RefCounted = null
var _root: Node3D = null
var _frames: int = 0
var _ready_for_checks := false
var _load_ms := 0.0
var _build_ms := 0.0


func _initialize() -> void:
	var args := OS.get_cmdline_user_args()
	for i in args.size():
		match args[i]:
			"--async-build":
				_async_build = true
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
	var load_started := Time.get_ticks_usec()
	if not _loader.load_export(_export_dir):
		_write_failure("load_failed", _loader.errors)
		quit(1)
		return
	_load_ms = float(Time.get_ticks_usec() - load_started) / 1000.0

	# Declare the perception focus explicitly. The importer keeps chunks that
	# intersect this sensor footprint at the source heightfield resolution while
	# decimating farther preview chunks.
	_loader.set_visual_focus(Vector3.ZERO, 0.25)
	var build_started := Time.get_ticks_usec()
	if _async_build:
		_root = await _loader.build_scene_async(root, 4)
	else:
		_root = _loader.build_scene(root)
	_build_ms = float(Time.get_ticks_usec() - build_started) / 1000.0
	if _root == null:
		_write_failure("build_failed", _loader.errors)
		quit(1)
		return
	_ready_for_checks = true
	print("loaded %d layers from %s" % [_loader.layers.size(), _export_dir])


func _process(_delta: float) -> bool:
	if not _ready_for_checks:
		return false
	# Give the physics server time to register heightfields and bake the convex
	# physical-rock proxies. Heightfields are queryable after two frames, while
	# the real rock population needs several more on the headless Jolt backend.
	_frames += 1
	if _frames < 10:
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
		query.collision_mask = 1 # Terrain only; physical rocks occupy layer 2.
		var hit := space.intersect_ray(query)

		var entry := {"x": x, "z": z, "expected_m": expected, "on_grid": on_grid}
		if hit.is_empty():
			# Diagnose rather than just counting: retry from far above with a
			# much longer ray, which distinguishes "no collider here at all"
			# from "the 100 m ray was too short or started inside geometry".
			var wide := PhysicsRayQueryParameters3D.create(
				Vector3(x, 5000.0, z), Vector3(x, -5000.0, z)
			)
			wide.collision_mask = 1
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

	var visual_chunks := 0
	var full_resolution_chunks := 0
	var decimated_chunks := 0
	var visual_chunk_layout: Array = []
	# Godot renders clockwise-wound triangles as front faces (ArrayMesh docs) and
	# the default material culls back faces, so a terrain wound the other way is
	# invisible from above even though every physics probe passes. Plane(a, b, c)
	# takes its points in clockwise order and reports the front-face normal;
	# an upward-facing terrain triangle must therefore report normal.y > 0.
	var render_triangles := 0
	var render_back_facing_triangles := 0
	for terrain_name in ["ContextTerrain", "MissionTerrain", "OperationalTerrain"]:
		var terrain_node := _root.get_node(terrain_name)
		for child in terrain_node.get_children():
			if not child.has_meta("visual_step"):
				continue
			visual_chunks += 1
			var chunk_arrays := (child.mesh as ArrayMesh).surface_get_arrays(0)
			var chunk_vertices: PackedVector3Array = chunk_arrays[Mesh.ARRAY_VERTEX]
			var chunk_indices: PackedInt32Array = chunk_arrays[Mesh.ARRAY_INDEX]
			for offset in range(0, chunk_indices.size(), 3):
				render_triangles += 1
				var winding_normal := Plane(
					chunk_vertices[chunk_indices[offset]],
					chunk_vertices[chunk_indices[offset + 1]],
					chunk_vertices[chunk_indices[offset + 2]]
				).normal
				if winding_normal.y <= 0.0:
					render_back_facing_triangles += 1
			if int(child.get_meta("visual_step")) == 1:
				full_resolution_chunks += 1
			else:
				decimated_chunks += 1
			visual_chunk_layout.append(
				"%s/%s:%d:%dx%d" % [
					terrain_name,
					child.name,
					int(child.get_meta("visual_step")),
					int(child.get_meta("width_samples")),
					int(child.get_meta("height_samples")),
				]
			)
	var collision_chunk_layout: Array = []
	for child in _root.get_node("TerrainCollision").get_children():
		collision_chunk_layout.append(
			"%s:%s:%dx%d" % [
				child.name,
				String(child.get_meta("layer_id")),
				int(child.get_meta("width_samples")),
				int(child.get_meta("height_samples")),
			]
		)

	# Read the actual focused render mesh at the origin and compare it with the
	# full-resolution heightfield and physics surface. This is deliberately not
	# a loader helper: inspecting ARRAY_VERTEX proves what Godot will render.
	var focus_visual_y := NAN
	var operational := _root.get_node("OperationalTerrain")
	for child in operational.get_children():
		if int(child.get_meta("visual_step", 0)) != 1:
			continue
		var mesh: ArrayMesh = child.mesh
		var arrays := mesh.surface_get_arrays(0)
		var vertices: PackedVector3Array = arrays[Mesh.ARRAY_VERTEX]
		for vertex in vertices:
			if absf(vertex.x) < 1.0e-6 and absf(vertex.z) < 1.0e-6:
				focus_visual_y = vertex.y
				break
		if not is_nan(focus_visual_y):
			break
	var focus_expected_y: float = _loader.elevation_at(0.0, 0.0)
	var focus_query := PhysicsRayQueryParameters3D.create(
		Vector3(0.0, focus_expected_y + 50.0, 0.0),
		Vector3(0.0, focus_expected_y - 50.0, 0.0)
	)
	focus_query.collision_mask = 1
	var focus_hit := space.intersect_ray(focus_query)
	var focus_collision_y := (
		float((focus_hit["position"] as Vector3).y) if not focus_hit.is_empty() else NAN
	)
	var focus_render_collision_error_m := 0.0
	var focus_geometry_missed := 0
	var focus_probe_count := 0
	var focus_points := [
		Vector2(0.0074, 0.0046),
		Vector2(0.1125, 0.0675),
		Vector2(-0.1125, 0.0675),
		Vector2(0.1125, -0.0675),
		Vector2(-0.1125, -0.0675),
		Vector2(0.045, 0.16),
		Vector2(-0.045, -0.16),
	]
	for point in focus_points:
		focus_probe_count += 1
		var render_y := _mesh_height_at(operational, point.x, point.y)
		var expected_y: float = _loader.elevation_at(point.x, point.y)
		var query := PhysicsRayQueryParameters3D.create(
			Vector3(point.x, expected_y + 50.0, point.y),
			Vector3(point.x, expected_y - 50.0, point.y)
		)
		query.collision_mask = 1
		var hit := space.intersect_ray(query)
		if is_nan(render_y) or hit.is_empty():
			focus_geometry_missed += 1
			continue
		focus_render_collision_error_m = maxf(
			focus_render_collision_error_m,
			absf(render_y - float((hit["position"] as Vector3).y))
		)

	var rock_collision_root := _root.get_node("PhysicalRockCollision")
	var rocks_payload: Dictionary = JSON.parse_string(
		FileAccess.get_file_as_string(_export_dir.path_join("rocks.json"))
	)
	var expected_physical_ids: Dictionary = {}
	var visual_ids: Dictionary = {}
	for rock_variant in rocks_payload.get("rocks", []):
		var rock: Dictionary = rock_variant
		if bool(rock.get("physical", false)):
			expected_physical_ids[String(rock.get("id"))] = true
		else:
			visual_ids[String(rock.get("id"))] = true
	var rock_collision_bodies := rock_collision_root.get_child_count()
	var physical_collision_shapes := 0
	var max_rock_shapes_per_body := 0
	var collision_ids: Dictionary = {}
	var duplicate_collision_ids := 0
	var rock_collision_layout: Array = []
	for body in rock_collision_root.get_children():
		physical_collision_shapes += body.get_child_count()
		max_rock_shapes_per_body = maxi(max_rock_shapes_per_body, body.get_child_count())
		rock_collision_layout.append("%s:%d" % [body.name, body.get_child_count()])
		for shape in body.get_children():
			var rock_id := String(shape.get_meta("rock_id", ""))
			if collision_ids.has(rock_id):
				duplicate_collision_ids += 1
			collision_ids[rock_id] = true
	var collision_ids_match_physical := (
		duplicate_collision_ids == 0
		and collision_ids.size() == expected_physical_ids.size()
	)
	for rock_id in collision_ids:
		if not expected_physical_ids.has(rock_id):
			collision_ids_match_physical = false
			break
	var visual_collision_ids := 0
	for rock_id in visual_ids:
		if collision_ids.has(rock_id):
			visual_collision_ids += 1

	var physical_mm: MultiMesh = _root.get_node("PhysicalRocks").multimesh
	var visual_mm: MultiMesh = _root.get_node("VisualRocks").multimesh

	# Rock ellipsoid semi-axes (scale_m) are local: the collision proxy scales
	# its points in the rock frame and then rotates, and the browser viewer
	# composes T*R*S. The rendered instance basis must agree, i.e. each basis
	# column is the rotated local axis times that axis' semi-axis. Instance
	# transforms are not readable back from the headless RenderingServer, so
	# the loader's basis helper is checked against the checksum-verified
	# rocks.json here.
	var rock_visual_basis_mismatches := 0
	var rock_visual_basis_checked := 0
	for rock_variant in rocks_payload.get("rocks", []):
		var rock: Dictionary = rock_variant
		var s: Array = rock.get("scale_m")
		var q: Array = rock.get("rotation_quaternion")
		var rotation := Quaternion(float(q[0]), float(q[1]), float(q[2]), float(q[3])).normalized()
		var scale := Vector3(float(s[0]), float(s[1]), float(s[2]))
		var rotated := Basis(rotation)
		var expected := Basis(rotated.x * scale.x, rotated.y * scale.y, rotated.z * scale.z)
		var actual: Basis = _loader.rock_instance_basis(rotation, scale)
		rock_visual_basis_checked += 1
		if not actual.is_equal_approx(expected):
			rock_visual_basis_mismatches += 1
	var physical_rock_raycast_hit := false
	if physical_collision_shapes > 0:
		var first_body: StaticBody3D = rock_collision_root.get_child(0)
		var first_shape: CollisionShape3D = first_body.get_child(0)
		var p := first_shape.global_position
		var rock_query := PhysicsRayQueryParameters3D.create(
			p + Vector3.UP * 2.0, p - Vector3.UP * 2.0
		)
		rock_query.collision_mask = 2
		physical_rock_raycast_hit = not space.intersect_ray(rock_query).is_empty()

	# Find a visual-only instance with no collision-layer-2 hit. Iterating is
	# deterministic and avoids mistaking a coincident physical rock for a visual
	# rock collider. Positions come from the checksum-verified real rocks.json;
	# the headless RenderingServer does not retain readable MultiMesh transforms.
	var visual_rock_tested := false
	var visual_rock_raycast_hit := true
	for rock_variant in rocks_payload.get("rocks", []):
		var rock: Dictionary = rock_variant
		if bool(rock.get("physical", false)):
			continue
		var position: Array = rock.get("position_m")
		var p := Vector3(float(position[0]), float(position[1]), float(position[2]))
		var rock_query := PhysicsRayQueryParameters3D.create(
			p + Vector3.UP * 2.0, p - Vector3.UP * 2.0
		)
		rock_query.collision_mask = 2
		var visual_hit := not space.intersect_ray(rock_query).is_empty()
		if not visual_hit:
			visual_rock_tested = true
			visual_rock_raycast_hit = false
			break

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
		"visual_chunks": visual_chunks,
		"render_triangles": render_triangles,
		"render_back_facing_triangles": render_back_facing_triangles,
		"rock_visual_basis_checked": rock_visual_basis_checked,
		"rock_visual_basis_mismatches": rock_visual_basis_mismatches,
		"full_resolution_chunks": full_resolution_chunks,
		"decimated_chunks": decimated_chunks,
		"visual_chunk_layout": visual_chunk_layout,
		"collision_chunk_layout": collision_chunk_layout,
		"focus_visual_error_m": absf(focus_visual_y - focus_expected_y),
		"focus_collision_error_m": absf(focus_collision_y - focus_expected_y),
		"focus_render_collision_error_m": focus_render_collision_error_m,
		"focus_geometry_missed": focus_geometry_missed,
		"focus_probe_count": focus_probe_count,
		"rock_collision_bodies": rock_collision_bodies,
		"physical_collision_shapes": physical_collision_shapes,
		"max_rock_shapes_per_body": max_rock_shapes_per_body,
		"rock_collision_layout": rock_collision_layout,
		"collision_ids_match_physical": collision_ids_match_physical,
		"visual_collision_ids": visual_collision_ids,
		"physical_rock_raycast_hit": physical_rock_raycast_hit,
		"visual_rock_tested": visual_rock_tested,
		"visual_rock_raycast_hit": visual_rock_raycast_hit,
		"load_ms": _load_ms,
		"build_ms": _build_ms,
		"async_build": _async_build,
		"async_build_yields": int(_root.get_meta("async_build_yields", 0)),
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


func _mesh_height_at(container: Node, x: float, z: float) -> float:
	for child in container.get_children():
		if (
			int(child.get_meta("visual_step", 0)) != 1
			or x < float(child.get_meta("min_x"))
			or x > float(child.get_meta("max_x"))
			or z < float(child.get_meta("min_z"))
			or z > float(child.get_meta("max_z"))
		):
			continue
		var mesh: ArrayMesh = child.mesh
		var arrays := mesh.surface_get_arrays(0)
		var vertices: PackedVector3Array = arrays[Mesh.ARRAY_VERTEX]
		var indices: PackedInt32Array = arrays[Mesh.ARRAY_INDEX]
		for offset in range(0, indices.size(), 3):
			var a := vertices[indices[offset]]
			var b := vertices[indices[offset + 1]]
			var c := vertices[indices[offset + 2]]
			var denominator := (b.z - c.z) * (a.x - c.x) + (c.x - b.x) * (a.z - c.z)
			if absf(denominator) <= 1.0e-12:
				continue
			var wa := ((b.z - c.z) * (x - c.x) + (c.x - b.x) * (z - c.z)) / denominator
			var wb := ((c.z - a.z) * (x - c.x) + (a.x - c.x) * (z - c.z)) / denominator
			var wc := 1.0 - wa - wb
			if wa >= -1.0e-6 and wb >= -1.0e-6 and wc >= -1.0e-6:
				return wa * a.y + wb * b.y + wc * c.y
	return NAN


func _write_failure(reason: String, details) -> void:
	var f := FileAccess.open(_out_path, FileAccess.WRITE)
	if f != null:
		f.store_string(JSON.stringify({"ok": false, "reason": reason, "details": details}, "  "))
		f.close()
	push_error("%s: %s" % [reason, details])
