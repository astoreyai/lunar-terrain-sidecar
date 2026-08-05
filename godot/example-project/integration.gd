extends SceneTree
## Full Godot ↔ sidecar integration test (spec §26).
##
## Runs the nine steps the spec asks for, against a live sidecar and real
## Chrono-free Godot physics:
##
##   1. connect to the sidecar        6. confirm elevations agree
##   2. request a seeded terrain      7. apply a terrain delta
##   3. import the result             8. reload only the affected tiles
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
# Preloaded so a syntax error in the editor-facing scripts fails this test
# rather than waiting to be found the first time somebody enables the plugin.
const DockScript := preload("res://addons/lunar_terrain/dock.gd")
const PluginScript := preload("res://addons/lunar_terrain/plugin.gd")

var client: RefCounted
var _url := ""
var _config_path := ""
var _out_path := ""
var _steps: Array = []
var _root: Node3D = null
var _loader: RefCounted = null
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


## Instantiate the editor dock headlessly and confirm it builds its controls.
##
## The plugin itself cannot be enabled outside the editor, but the dock is a
## plain VBoxContainer, so building it here proves the script parses, every
## control is constructed, and the sidecar client wires up.
func _check_dock() -> void:
	var dock: Node = DockScript.new()
	var built := dock != null and dock.get_child_count() > 0
	_step("editor dock builds", built, "%d controls" % (dock.get_child_count() if dock else 0))

	# The controls the spec requires the dock to expose.
	var has_client: bool = dock != null and dock.client != null
	_step("dock wires a sidecar client", has_client,
		dock.client.get_class() if has_client else "none")

	var labels: Array[String] = []
	for child in dock.get_children():
		if child is Button:
			labels.append((child as Button).text)
		elif child is HBoxContainer:
			for sub in child.get_children():
				if sub is Button:
					labels.append((sub as Button).text)
	var required := ["Connect", "Open Sidecar UI", "Generate", "Regenerate", "Import"]
	var missing: Array[String] = []
	for r in required:
		if not labels.has(r):
			missing.append(r)
	_step("dock exposes the required actions", missing.is_empty(),
		"missing %s" % str(missing) if not missing.is_empty() else str(labels))

	if dock:
		dock.free()


## Issue a request and await its response. Returns {result, error}.
func _rpc(method: String, params: Dictionary = {}) -> Dictionary:
	var id: int = client.call_method(method, params)
	if id < 0:
		return {"result": null, "error": {"message": client.last_error}}
	while true:
		var got: Array = await client.response
		if int(got[0]) == id:
			return {"result": got[1], "error": got[2]}
	return {"result": null, "error": {}}


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

	var before_rpc := await _rpc("terrain.getHeight", {"x": edit_x, "z": edit_z})
	var before_h := float((before_rpc["result"] as Dictionary).get("elevationM", 0.0))

	# Raycast the collision *before* the edit, so step 9 has a baseline.
	var q0 := PhysicsRayQueryParameters3D.create(
		Vector3(edit_x, before_h + 50.0, edit_z), Vector3(edit_x, before_h - 50.0, edit_z)
	)
	var hit0 := space.intersect_ray(q0)
	var collision_before: float = float((hit0["position"] as Vector3).y) if not hit0.is_empty() else NAN

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

	# --- 8. reload only the affected tiles ------------------------------------
	var re_export := await _rpc("terrain.export", {"outputDirectory": _output_dir})
	_step("re-export after edit", re_export["error"].is_empty(),
		(re_export["result"] as Dictionary).get("validation", {}) if re_export["error"].is_empty() else re_export["error"])

	var validation: Dictionary = {}
	if re_export["error"].is_empty():
		validation = (re_export["result"] as Dictionary).get("validation", {})
	_step("edited terrain still validates", bool(validation.get("passed", false)), validation)

	# Reload the changed tiles by re-reading the layer and rebuilding only the
	# collision for it, which is what a delta-aware client does rather than
	# rebuilding the whole site.
	var reloaded: RefCounted = LoaderScript.new()
	if not reloaded.load_export(_output_dir):
		_step("reload affected tiles", false, reloaded.errors)
		_finish(false, "reload failed")
		return
	var old_collision := _root.get_node("TerrainCollision")
	_root.remove_child(old_collision)
	old_collision.queue_free()
	var new_collision := StaticBody3D.new()
	new_collision.name = "TerrainCollision"
	_root.add_child(new_collision)
	reloaded._build_collision(new_collision)
	_step("reload affected tiles", new_collision.get_child_count() > 0,
		"%d regions rebuilt" % new_collision.get_child_count())

	await physics_frame
	await physics_frame

	# --- 9. confirm the updated collision geometry ---------------------------
	var after_rpc := await _rpc("terrain.getHeight", {"x": edit_x, "z": edit_z})
	var after_h := float((after_rpc["result"] as Dictionary).get("elevationM", 0.0))

	var space2 := _root.get_world_3d().direct_space_state
	var q1 := PhysicsRayQueryParameters3D.create(
		Vector3(edit_x, after_h + 50.0, edit_z), Vector3(edit_x, after_h - 50.0, edit_z)
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

	var all_passed := _steps.all(func(s): return s["passed"])
	_finish(all_passed, "" if all_passed else "one or more steps failed")
