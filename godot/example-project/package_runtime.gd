extends Node3D
## Loads the saved PackedScene and raycasts its deserialized terrain and physical
## rock collision. This is the main scene in both the editor-run reload and the
## exported Linux package.

const PACKED_TERRAIN := "res://packed_terrain.scn"

var _out_path := ""
var _mode := ""
var _expected_terrain_id := ""
var _probe_x := 0.0
var _probe_z := 0.0
var _expected_y := 0.0
var _terrain: Node3D
var _physics_frames := 0


func _ready() -> void:
	if not _parse_args(OS.get_cmdline_user_args()):
		_fail("usage", "--out <file> --mode <name> --terrain-id <id> --x <m> --z <m> --expected-y <m>")
		return

	var resource := ResourceLoader.load(PACKED_TERRAIN, "PackedScene", ResourceLoader.CACHE_MODE_IGNORE)
	if not resource is PackedScene:
		_fail("scene_load_failed", "could not load %s" % PACKED_TERRAIN)
		return

	var instance := (resource as PackedScene).instantiate()
	if not instance is Node3D:
		_fail("scene_instantiate_failed", "packed root is not Node3D")
		return
	_terrain = instance as Node3D
	add_child(_terrain)


func _physics_process(_delta: float) -> void:
	if _terrain == null:
		return
	_physics_frames += 1
	if _physics_frames < 3:
		return
	_run_probe()


func _run_probe() -> void:
	var metadata := _terrain.get_node_or_null("TerrainMetadata")
	var collision := _terrain.get_node_or_null("TerrainCollision")
	var rock_collision := _terrain.get_node_or_null("PhysicalRockCollision")
	var physical_rocks := _terrain.get_node_or_null("PhysicalRocks")
	if metadata == null or collision == null or rock_collision == null or physical_rocks == null:
		_fail("scene_contract_missing", "required terrain or rock nodes missing after reload")
		return
	var physical_collision_shapes := 0
	for body in rock_collision.get_children():
		physical_collision_shapes += body.get_child_count()

	var query := PhysicsRayQueryParameters3D.create(
		Vector3(_probe_x, _expected_y + 50.0, _probe_z),
		Vector3(_probe_x, _expected_y - 50.0, _probe_z)
	)
	query.collide_with_areas = false
	query.collide_with_bodies = true
	query.collision_mask = 1
	var hit := get_world_3d().direct_space_state.intersect_ray(query)
	if hit.is_empty():
		_fail("raycast_missed", {"x": _probe_x, "z": _probe_z, "expected_y": _expected_y})
		return

	var rock_shape: CollisionShape3D = null
	for body in rock_collision.get_children():
		for candidate in body.get_children():
			if candidate is CollisionShape3D:
				rock_shape = candidate as CollisionShape3D
				break
		if rock_shape != null:
			break
	if rock_shape == null:
		_fail("rock_collision_missing", "no physical rock collision shape survived scene loading")
		return
	var rock_position := rock_shape.global_position
	var rock_query := PhysicsRayQueryParameters3D.create(
		rock_position + Vector3(0.0, 50.0, 0.0),
		rock_position - Vector3(0.0, 50.0, 0.0)
	)
	rock_query.collide_with_areas = false
	rock_query.collide_with_bodies = true
	rock_query.collision_mask = 2
	var rock_hit := get_world_3d().direct_space_state.intersect_ray(rock_query)
	if rock_hit.is_empty():
		_fail(
			"rock_raycast_missed",
			{"rock_id": rock_shape.get_meta("rock_id", ""), "position": rock_position}
		)
		return
	if not rock_hit["collider"] is CollisionObject3D:
		_fail("rock_collider_invalid", "rock raycast did not return a collision body")
		return

	var hit_y := float((hit["position"] as Vector3).y)
	var rock_hit_y := float((rock_hit["position"] as Vector3).y)
	var rock_collider := rock_hit["collider"] as CollisionObject3D
	var terrain_id := str(metadata.get_meta("terrain_id", ""))
	var cs: Dictionary = metadata.get_meta("coordinate_system", {})
	_write_report({
		"ok": terrain_id == _expected_terrain_id,
		"mode": _mode,
		"terrain_id": terrain_id,
		"coordinate_system": cs,
		"collision_shapes": collision.get_child_count(),
		"physical_rocks": physical_rocks.multimesh.instance_count,
		"rock_collision_bodies": rock_collision.get_child_count(),
		"physical_collision_shapes": physical_collision_shapes,
		"probe": {
			"x": _probe_x,
			"z": _probe_z,
			"expected_y": _expected_y,
			"hit_y": hit_y,
			"absolute_error_m": absf(hit_y - _expected_y),
		},
		"rock_probe": {
			"rock_id": rock_shape.get_meta("rock_id", ""),
			"x": rock_position.x,
			"z": rock_position.z,
			"hit_y": rock_hit_y,
			"collision_layer": rock_collider.collision_layer,
		},
		"godot_version": Engine.get_version_info(),
	})
	get_tree().quit(0 if terrain_id == _expected_terrain_id else 1)


func _parse_args(args: PackedStringArray) -> bool:
	var seen := {}
	var i := 0
	while i < args.size():
		if i + 1 >= args.size():
			return false
		var value := args[i + 1]
		match args[i]:
			"--out":
				_out_path = value
			"--mode":
				_mode = value
			"--terrain-id":
				_expected_terrain_id = value
			"--x":
				_probe_x = value.to_float()
			"--z":
				_probe_z = value.to_float()
			"--expected-y":
				_expected_y = value.to_float()
			_:
				return false
		seen[args[i]] = true
		i += 2
	return (
		seen.has("--out")
		and seen.has("--mode")
		and seen.has("--terrain-id")
		and seen.has("--x")
		and seen.has("--z")
		and seen.has("--expected-y")
	)


func _fail(reason: String, detail: Variant) -> void:
	_write_report({"ok": false, "mode": _mode, "reason": reason, "detail": detail})
	push_error("%s: %s" % [reason, detail])
	get_tree().quit(1)


func _write_report(report: Dictionary) -> void:
	if _out_path.is_empty():
		return
	var output := FileAccess.open(_out_path, FileAccess.WRITE)
	if output == null:
		push_error("cannot write %s" % _out_path)
		return
	output.store_string(JSON.stringify(report, "  "))
	output.close()
