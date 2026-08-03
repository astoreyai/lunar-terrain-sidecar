class_name LunarTerrainLoader
extends RefCounted
## Loads a lunar-terrain-sidecar export into a Godot scene (spec §17).
##
## Reads the sidecar's manifest and raw float32 heightfields and builds:
##
##     LunarTerrainRoot
##     ├── ContextTerrain / MissionTerrain / OperationalTerrain  (MeshInstance3D)
##     ├── TerrainCollision                                      (StaticBody3D)
##     ├── PhysicalRocks / VisualRocks                           (MultiMeshInstance3D)
##     └── TerrainMetadata                                       (Node)
##
## COORDINATE CONTRACT (manifest `coordinate_system`, ADR 0002):
##   right-handed, +X east, +Y up, +Z SOUTH — north is -Z.
##   Grid col increases +X; grid row increases +Z, so row 0 is northernmost.
##   Metres throughout. No scale factor and no axis swap are applied on import;
##   if one were needed, the sidecar's frame and Godot's would disagree and the
##   round-trip elevation check would fail loudly rather than silently.

const HEIGHT_FILE := "height.rf32"


## One layer of the nested terrain.
class LayerData extends RefCounted:
	var id: String
	var role: String
	var resolution_m: float
	var width_samples: int
	var height_samples: int
	var min_x: float
	var min_z: float
	var min_y: float
	var max_y: float
	var heights: PackedFloat32Array

	## Bilinear elevation at a world position. NAN outside the layer.
	func height_at(x: float, z: float) -> float:
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


## Load a manifest and every layer it declares. Returns false on failure.
func load_export(directory: String) -> bool:
	_root_dir = directory
	errors.clear()
	layers.clear()

	var manifest_path := directory.path_join("manifest.json")
	if not FileAccess.file_exists(manifest_path):
		errors.append("manifest.json not found at %s" % manifest_path)
		return false

	var text := FileAccess.get_file_as_string(manifest_path)
	var parsed: Variant = JSON.parse_string(text)
	if typeof(parsed) != TYPE_DICTIONARY:
		errors.append("manifest.json did not parse as an object")
		return false
	manifest = parsed

	if not _verify_coordinate_system():
		return false

	for layer_variant in manifest.get("layers", []):
		var lm: Dictionary = layer_variant
		var layer := LayerData.new()
		layer.id = lm.get("id", "")
		layer.role = lm.get("role", "")
		layer.resolution_m = float(lm.get("resolution_m", 0.0))
		layer.width_samples = int(lm.get("width_samples", 0))
		layer.height_samples = int(lm.get("height_samples", 0))
		var bounds: Dictionary = lm.get("bounds", {})
		var mn: Array = bounds.get("minimum", [0, 0, 0])
		var mx: Array = bounds.get("maximum", [0, 0, 0])
		layer.min_x = float(mn[0])
		layer.min_y = float(mn[1])
		layer.min_z = float(mn[2])
		layer.max_y = float(mx[1])

		if not _load_heights(layer):
			return false
		layers.append(layer)

	return errors.is_empty()


## The sidecar declares its frame explicitly; refuse anything unexpected rather
## than importing a mirrored or inside-out site.
func _verify_coordinate_system() -> bool:
	var cs: Dictionary = manifest.get("coordinate_system", {})
	if cs.is_empty():
		errors.append("manifest declares no coordinate_system")
		return false
	if cs.get("handedness", "") != "right":
		errors.append("expected a right-handed frame, got '%s'" % cs.get("handedness", ""))
		return false
	if cs.get("up_axis", "") != "+Y":
		errors.append("expected +Y up, got '%s'" % cs.get("up_axis", ""))
		return false
	if cs.get("north_axis", "") != "-Z":
		errors.append("expected north on -Z, got '%s'" % cs.get("north_axis", ""))
		return false
	if cs.get("linear_unit", "") != "meter":
		errors.append("expected metres, got '%s'" % cs.get("linear_unit", ""))
		return false
	return true


func _load_heights(layer: LayerData) -> bool:
	var path := _root_dir.path_join("layers").path_join(layer.id).path_join(HEIGHT_FILE)
	var f := FileAccess.open(path, FileAccess.READ)
	if f == null:
		errors.append("cannot open %s" % path)
		return false
	var bytes := f.get_buffer(f.get_length())
	f.close()

	var expected := layer.width_samples * layer.height_samples
	if bytes.size() != expected * 4:
		errors.append("%s: expected %d bytes, got %d" % [path, expected * 4, bytes.size()])
		return false

	# Little-endian float32, row-major — the manifest's declared encoding.
	layer.heights = bytes.to_float32_array()
	return layer.heights.size() == expected


## Build the scene graph. `parent` receives a single LunarTerrainRoot child.
func build_scene(parent: Node) -> Node3D:
	var root := Node3D.new()
	root.name = "LunarTerrainRoot"
	parent.add_child(root)

	var collision_parent := StaticBody3D.new()
	collision_parent.name = "TerrainCollision"
	root.add_child(collision_parent)

	for layer in layers:
		var mesh_instance := MeshInstance3D.new()
		mesh_instance.name = _node_name_for_role(layer.role)
		mesh_instance.mesh = build_layer_mesh(layer)
		root.add_child(mesh_instance)

	_build_collision(collision_parent)
	_build_rocks(root)
	_build_metadata(root)
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
	# Coarsest first, so `layers_sorted[i + 1]` is the tier nested inside i.
	var sorted_layers := layers.duplicate()
	sorted_layers.sort_custom(func(a, b): return a.resolution_m > b.resolution_m)

	for i in sorted_layers.size():
		var layer: LayerData = sorted_layers[i]
		var child: LayerData = sorted_layers[i + 1] if i + 1 < sorted_layers.size() else null

		if child == null:
			_add_collision_region(body, layer, 0, 0, layer.width_samples, layer.height_samples, "full")
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
			_add_collision_region(body, layer, 0, 0, layer.width_samples, r0 + 1, "north")
		# South band.
		if r1 <= layer.height_samples - 2:
			_add_collision_region(
				body, layer, 0, r1, layer.width_samples, layer.height_samples - r1, "south"
			)
		# West band, spanning only the child's row range.
		if c0 >= 1:
			_add_collision_region(body, layer, 0, r0, c0 + 1, r1 - r0 + 1, "west")
		# East band.
		if c1 <= layer.width_samples - 2:
			_add_collision_region(
				body, layer, c1, r0, layer.width_samples - c1, r1 - r0 + 1, "east"
			)


## One HeightMapShape3D covering a sub-rectangle of a layer's grid.
func _add_collision_region(
	body: StaticBody3D, layer: LayerData, col0: int, row0: int, w: int, h: int, tag: String
) -> void:
	if w < 2 or h < 2:
		return

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

	var node := CollisionShape3D.new()
	node.name = "%s_%s_%d_%d" % [_node_name_for_role(layer.role), tag, col0, row0]
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
	body.add_child(node)


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


## Visual mesh built directly from the heightfield.
##
## Winding matches the sidecar's GLB tiles: (v00, v01, v11) and (v00, v11, v10),
## which produce +Y normals for upward-facing ground.
func build_layer_mesh(layer: LayerData) -> ArrayMesh:
	var verts := PackedVector3Array()
	var normals := PackedVector3Array()
	var indices := PackedInt32Array()

	# Cap preview resolution so a 3001x3001 operational layer does not build a
	# nine-million-vertex mesh; collision always uses the full-resolution data.
	var step: int = maxi(1, int(ceil(float(maxi(layer.width_samples, layer.height_samples)) / 512.0)))
	var w := int(floor(float(layer.width_samples - 1) / float(step))) + 1
	var h := int(floor(float(layer.height_samples - 1) / float(step))) + 1

	verts.resize(w * h)
	normals.resize(w * h)

	for r in h:
		for c in w:
			var gc: int = mini(c * step, layer.width_samples - 1)
			var gr: int = mini(r * step, layer.height_samples - 1)
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
			indices.append_array([i00, i01, i11, i00, i11, i10])

	var arrays := []
	arrays.resize(Mesh.ARRAY_MAX)
	arrays[Mesh.ARRAY_VERTEX] = verts
	arrays[Mesh.ARRAY_NORMAL] = normals
	arrays[Mesh.ARRAY_INDEX] = indices

	var mesh := ArrayMesh.new()
	mesh.add_surface_from_arrays(Mesh.PRIMITIVE_TRIANGLES, arrays)
	return mesh


func _build_rocks(root: Node3D) -> void:
	var path := _root_dir.path_join("rocks.json")
	if not FileAccess.file_exists(path):
		return
	var parsed: Variant = JSON.parse_string(FileAccess.get_file_as_string(path))
	if typeof(parsed) != TYPE_DICTIONARY:
		errors.append("rocks.json did not parse as an object")
		return

	var physical: Array = []
	var visual: Array = []
	for rock_variant in (parsed as Dictionary).get("rocks", []):
		var rock: Dictionary = rock_variant
		if bool(rock.get("physical", false)):
			physical.append(rock)
		else:
			visual.append(rock)

	root.add_child(_make_rock_multimesh("PhysicalRocks", physical))
	root.add_child(_make_rock_multimesh("VisualRocks", visual))


func _make_rock_multimesh(node_name: String, rocks: Array) -> MultiMeshInstance3D:
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
	mm.instance_count = rocks.size()

	for i in rocks.size():
		var rock: Dictionary = rocks[i]
		var p: Array = rock.get("position_m", [0, 0, 0])
		var s: Array = rock.get("scale_m", [1, 1, 1])
		var q: Array = rock.get("rotation_quaternion", [0, 0, 0, 1])
		var basis := Basis(Quaternion(float(q[0]), float(q[1]), float(q[2]), float(q[3])))
		basis = basis.scaled(Vector3(float(s[0]), float(s[1]), float(s[2])))
		mm.set_instance_transform(
			i, Transform3D(basis, Vector3(float(p[0]), float(p[1]), float(p[2])))
		)

	node.multimesh = mm
	return node


func _build_metadata(root: Node3D) -> void:
	var node := Node.new()
	node.name = "TerrainMetadata"
	node.set_meta("terrain_id", manifest.get("terrainId", ""))
	node.set_meta("seed", manifest.get("seed", ""))
	node.set_meta("coordinate_system", manifest.get("coordinate_system", {}))
	node.set_meta("origin", manifest.get("origin", {}))
	node.set_meta("solar", manifest.get("solar", {}))
	node.set_meta("provenance", manifest.get("provenance", {}))
	root.add_child(node)


## Finest layer covering a world position — the sidecar's `elevationAt` rule,
## so both sides agree on which tier is authoritative.
func finest_layer_at(x: float, z: float) -> LayerData:
	var best: LayerData = null
	for layer in layers:
		var max_x := layer.min_x + float(layer.width_samples - 1) * layer.resolution_m
		var max_z := layer.min_z + float(layer.height_samples - 1) * layer.resolution_m
		if x < layer.min_x or x > max_x or z < layer.min_z or z > max_z:
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
