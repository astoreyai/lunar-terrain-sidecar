extends SceneTree
## Builds a terrain scene through the production addon and persists it as a
## PackedScene. A separate process performs the reload and physics check.

const LunarTerrainLoaderScript := preload("res://addons/lunar_terrain/lunar_terrain_loader.gd")

var _export_dir := ""
var _scene_path := ""
var _out_path := ""


func _initialize() -> void:
	var args := OS.get_cmdline_user_args()
	var parsed := _parse_args(args)
	if not parsed:
		_fail("usage", "--export-dir <dir> --scene <res://path.scn> --out <file>")
		return

	var loader := LunarTerrainLoaderScript.new()
	if not loader.load_export(_export_dir):
		_fail("load_failed", loader.errors)
		return

	var terrain: Node3D = loader.build_scene(root)
	_set_owner_recursive(terrain, terrain)

	var packed := PackedScene.new()
	var pack_error := packed.pack(terrain)
	if pack_error != OK:
		_fail("pack_failed", error_string(pack_error))
		return

	var save_error := ResourceSaver.save(packed, _scene_path)
	if save_error != OK:
		_fail("save_failed", error_string(save_error))
		return

	var absolute_scene_path := ProjectSettings.globalize_path(_scene_path)
	var saved_bytes := FileAccess.get_file_as_bytes(absolute_scene_path).size()
	var metadata := terrain.get_node("TerrainMetadata")
	var rock_collision := terrain.get_node("PhysicalRockCollision")
	var physical_collision_shapes := 0
	for body in rock_collision.get_children():
		physical_collision_shapes += body.get_child_count()
	_write_report({
		"ok": true,
		"scene_path": _scene_path,
		"saved_bytes": saved_bytes,
		"terrain_id": metadata.get_meta("terrain_id"),
		"seed": metadata.get_meta("seed"),
		"coordinate_system": metadata.get_meta("coordinate_system"),
		"collision_shapes": terrain.get_node("TerrainCollision").get_child_count(),
		"physical_rocks": terrain.get_node("PhysicalRocks").multimesh.instance_count,
		"rock_collision_bodies": rock_collision.get_child_count(),
		"physical_collision_shapes": physical_collision_shapes,
		"godot_version": Engine.get_version_info(),
	})
	quit(0)


func _parse_args(args: PackedStringArray) -> bool:
	var i := 0
	while i < args.size():
		if i + 1 >= args.size():
			return false
		match args[i]:
			"--export-dir":
				_export_dir = args[i + 1]
			"--scene":
				_scene_path = args[i + 1]
			"--out":
				_out_path = args[i + 1]
			_:
				return false
		i += 2
	return not _export_dir.is_empty() and _scene_path.begins_with("res://") and not _out_path.is_empty()


func _set_owner_recursive(node: Node, scene_owner: Node) -> void:
	for child in node.get_children():
		child.owner = scene_owner
		_set_owner_recursive(child, scene_owner)


func _fail(reason: String, detail: Variant) -> void:
	_write_report({"ok": false, "reason": reason, "detail": detail})
	push_error("%s: %s" % [reason, detail])
	quit(1)


func _write_report(report: Dictionary) -> void:
	if _out_path.is_empty():
		return
	var output := FileAccess.open(_out_path, FileAccess.WRITE)
	if output == null:
		push_error("cannot write %s" % _out_path)
		return
	output.store_string(JSON.stringify(report, "  "))
	output.close()
