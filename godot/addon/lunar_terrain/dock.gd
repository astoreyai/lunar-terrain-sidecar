@tool
class_name LunarTerrainDock
extends VBoxContainer
## Editor dock for the lunar terrain sidecar (spec §17).
##
## Built in code rather than as a `.tscn` so the whole dock is reviewable in one
## file and cannot drift from the script that drives it.
##
## Everything the spec asks a dock to show is here: connection indicator,
## configuration selector, seed field, Generate / Regenerate / Import, a link to
## the browser UI, live progress, validation results, the artifact list with
## checksum status, and the coordinate-system summary.

const SidecarClientScript := preload("res://addons/lunar_terrain/sidecar_client.gd")
const LoaderScript := preload("res://addons/lunar_terrain/lunar_terrain_loader.gd")

const DEFAULT_URL := "ws://127.0.0.1:8768"
const DEFAULT_UI_URL := "http://127.0.0.1:5173"

var client: RefCounted
var _status_dot: ColorRect
var _status_label: Label
var _url_edit: LineEdit
var _config_edit: LineEdit
var _seed_edit: LineEdit
var _output_edit: LineEdit
var _generate_button: Button
var _regenerate_button: Button
var _import_button: Button
var _progress: ProgressBar
var _stage_label: Label
var _log: RichTextLabel
var _artifacts: ItemList
var _coord_label: Label

var _current_job: String = ""
var _last_config: Dictionary = {}
var _last_output_dir: String = ""
var _pending: Dictionary = {}
## Node the imported terrain is parented to, so a re-import can replace it.
var _terrain_root: Node3D = null

signal terrain_imported(root: Node3D)


func _init() -> void:
	name = "Lunar Terrain"
	custom_minimum_size = Vector2(320, 0)
	add_theme_constant_override("separation", 6)
	_build_ui()
	_setup_client()


func _build_ui() -> void:
	# ------------------------------------------------------------ connection
	_section("Sidecar")

	var status_row := HBoxContainer.new()
	_status_dot = ColorRect.new()
	_status_dot.custom_minimum_size = Vector2(10, 10)
	_status_dot.color = Color(0.55, 0.58, 0.62)
	status_row.add_child(_status_dot)
	_status_label = Label.new()
	_status_label.text = "disconnected"
	status_row.add_child(_status_label)
	add_child(status_row)

	_url_edit = LineEdit.new()
	_url_edit.text = DEFAULT_URL
	_url_edit.tooltip_text = "Sidecar WebSocket endpoint"
	add_child(_url_edit)

	var conn_row := HBoxContainer.new()
	var connect_button := Button.new()
	connect_button.text = "Connect"
	connect_button.pressed.connect(_on_connect_pressed)
	conn_row.add_child(connect_button)

	var disconnect_button := Button.new()
	disconnect_button.text = "Disconnect"
	disconnect_button.pressed.connect(func() -> void: client.close())
	conn_row.add_child(disconnect_button)

	var ui_button := Button.new()
	ui_button.text = "Open Sidecar UI"
	ui_button.tooltip_text = "Open the browser terrain authoring UI"
	ui_button.pressed.connect(func() -> void: OS.shell_open(DEFAULT_UI_URL))
	conn_row.add_child(ui_button)
	add_child(conn_row)

	# --------------------------------------------------------- configuration
	_section("Configuration")

	var cfg_row := HBoxContainer.new()
	_config_edit = LineEdit.new()
	_config_edit.placeholder_text = "path to config.json"
	_config_edit.size_flags_horizontal = Control.SIZE_EXPAND_FILL
	cfg_row.add_child(_config_edit)
	var browse := Button.new()
	browse.text = "…"
	browse.tooltip_text = "Choose a terrain configuration"
	browse.pressed.connect(_on_browse_pressed)
	cfg_row.add_child(browse)
	add_child(cfg_row)

	_seed_edit = LineEdit.new()
	_seed_edit.placeholder_text = "seed (overrides the configuration)"
	add_child(_seed_edit)

	_output_edit = LineEdit.new()
	_output_edit.placeholder_text = "output directory (from the configuration)"
	add_child(_output_edit)

	# ----------------------------------------------------------- generation
	_section("Generation")

	var gen_row := HBoxContainer.new()
	_generate_button = Button.new()
	_generate_button.text = "Generate"
	_generate_button.pressed.connect(_on_generate_pressed)
	gen_row.add_child(_generate_button)

	_regenerate_button = Button.new()
	_regenerate_button.text = "Regenerate"
	_regenerate_button.tooltip_text = "Re-run the last configuration with a new random seed"
	_regenerate_button.pressed.connect(_on_regenerate_pressed)
	gen_row.add_child(_regenerate_button)

	_import_button = Button.new()
	_import_button.text = "Import"
	_import_button.tooltip_text = "Build scene nodes from the exported artifacts"
	_import_button.pressed.connect(_on_import_pressed)
	gen_row.add_child(_import_button)
	add_child(gen_row)

	_progress = ProgressBar.new()
	_progress.min_value = 0.0
	_progress.max_value = 1.0
	_progress.value = 0.0
	_progress.show_percentage = true
	add_child(_progress)

	_stage_label = Label.new()
	_stage_label.text = "idle"
	_stage_label.add_theme_font_size_override("font_size", 11)
	add_child(_stage_label)

	# ------------------------------------------------------------- artifacts
	_section("Artifacts")
	_artifacts = ItemList.new()
	_artifacts.custom_minimum_size = Vector2(0, 130)
	_artifacts.size_flags_vertical = Control.SIZE_EXPAND_FILL
	add_child(_artifacts)

	# ------------------------------------------------------ coordinate system
	_section("Coordinate system")
	_coord_label = Label.new()
	_coord_label.text = "(import a terrain to read its declared frame)"
	_coord_label.autowrap_mode = TextServer.AUTOWRAP_WORD_SMART
	_coord_label.add_theme_font_size_override("font_size", 11)
	add_child(_coord_label)

	# ------------------------------------------------------------------- log
	_section("Validation / log")
	_log = RichTextLabel.new()
	_log.custom_minimum_size = Vector2(0, 130)
	_log.size_flags_vertical = Control.SIZE_EXPAND_FILL
	_log.bbcode_enabled = true
	_log.scroll_following = true
	add_child(_log)


func _section(title: String) -> void:
	var sep := HSeparator.new()
	add_child(sep)
	var label := Label.new()
	label.text = title.to_upper()
	label.add_theme_font_size_override("font_size", 10)
	label.modulate = Color(0.62, 0.66, 0.72)
	add_child(label)


func _setup_client() -> void:
	client = SidecarClientScript.new()
	client.sidecar_connected.connect(_on_connected)
	client.sidecar_disconnected.connect(_on_disconnected)
	client.connection_failed.connect(_on_connection_failed)
	client.progress.connect(_on_progress)
	client.response.connect(_on_response)


func _process(_delta: float) -> void:
	if client:
		client.poll()


# --------------------------------------------------------------- connection

func _on_connect_pressed() -> void:
	_set_status("connecting", Color(1.0, 0.77, 0.0))
	client.connect_to_sidecar(_url_edit.text)


func _on_connected() -> void:
	_set_status("connected", Color(0.0, 1.0, 0.62))
	_info("connected to %s" % _url_edit.text)
	_pending[client.call_method("terrain.health")] = "health"


func _on_disconnected() -> void:
	_set_status("disconnected", Color(0.55, 0.58, 0.62))
	_info("disconnected")
	_abort_generation("sidecar disconnected")


func _on_connection_failed(reason: String) -> void:
	_set_status("unreachable", Color(1.0, 0.36, 0.36))
	_error(
		"%s\nStart it with:  npm run serve   (or `lunar-terrain serve --port 8768`)" % reason
	)
	_abort_generation(reason)


## A disconnect mid-generation previously left Generate/Regenerate disabled
## forever and let the status poll loop die silently. Fail loudly and recover.
func _abort_generation(reason: String) -> void:
	if _generate_button.disabled or _regenerate_button.disabled:
		_error("generation aborted: %s" % reason)
	_generate_button.disabled = false
	_regenerate_button.disabled = false
	_current_job = ""
	_pending.clear()
	_stage_label.text = "idle"


func _set_status(text: String, color: Color) -> void:
	_status_label.text = text
	_status_dot.color = color


# --------------------------------------------------------------- generation

func _on_browse_pressed() -> void:
	var dialog := FileDialog.new()
	dialog.file_mode = FileDialog.FILE_MODE_OPEN_FILE
	dialog.access = FileDialog.ACCESS_FILESYSTEM
	dialog.add_filter("*.json", "Terrain configuration")
	dialog.file_selected.connect(func(path: String) -> void:
		_config_edit.text = path
		dialog.queue_free()
	)
	add_child(dialog)
	dialog.popup_centered_ratio(0.6)


func _on_generate_pressed() -> void:
	if not client.is_connected_to_sidecar():
		_error("not connected — press Connect first")
		return
	var path := _config_edit.text.strip_edges()
	if path.is_empty():
		_error("choose a configuration file first")
		return
	# Ask the sidecar to read and validate the file; it owns the schema, so the
	# dock never has to keep a second copy of it in sync.
	_pending[client.call_method("terrain.loadConfig", {"path": path})] = "loadConfig"
	_info("loading %s" % path)


func _on_regenerate_pressed() -> void:
	if _last_config.is_empty():
		_error("nothing to regenerate — run Generate first")
		return
	var config := _last_config.duplicate(true)
	config["seed"] = "%s-%d" % [config.get("seed", "seed"), randi()]
	_seed_edit.text = String(config["seed"])
	_submit(config)


func _submit(config: Dictionary) -> void:
	if not _seed_edit.text.strip_edges().is_empty():
		config["seed"] = _seed_edit.text.strip_edges()
	if not _output_edit.text.strip_edges().is_empty():
		config["outputDirectory"] = _output_edit.text.strip_edges()

	_last_config = config.duplicate(true)
	_last_output_dir = String(config.get("outputDirectory", ""))
	_output_edit.text = _last_output_dir
	_seed_edit.text = String(config.get("seed", ""))

	_progress.value = 0.0
	_stage_label.text = "queued"
	_generate_button.disabled = true
	_regenerate_button.disabled = true
	_pending[client.call_method("terrain.generate", {"config": config})] = "generate"


func _on_progress(job_id: String, stage: String, fraction: float, detail: String) -> void:
	if job_id != _current_job and not _current_job.is_empty():
		return
	_progress.value = fraction
	_stage_label.text = "%s  %d%%%s" % [stage, int(fraction * 100.0), (" · " + detail) if not detail.is_empty() else ""]


func _on_response(id: int, result: Variant, error: Dictionary) -> void:
	var kind := String(_pending.get(id, ""))
	_pending.erase(id)

	if not error.is_empty():
		_generate_button.disabled = false
		_regenerate_button.disabled = false
		_error(SidecarClientScript.describe_error(error))
		return

	match kind:
		"health":
			var h: Dictionary = result
			_info(
				"protocol %s · generator %s" % [h.get("protocolVersion", "?"), h.get("generatorVersion", "?")]
			)
		"loadConfig":
			_submit(result as Dictionary)
		"generate":
			var g: Dictionary = result
			_current_job = String(g.get("jobId", ""))
			_info("job %s queued (seed %s)" % [_current_job, g.get("seed", "")])
			_poll_status()
		"status":
			_handle_status(result as Dictionary)
		"export":
			var e: Dictionary = result
			var v: Dictionary = e.get("validation", {})
			if bool(v.get("passed", false)):
				_ok("validation PASSED — %d artifacts, %.1f MB" % [
					int(e.get("artifacts", 0)), float(e.get("totalBytes", 0)) / 1e6
				])
			else:
				_error("validation FAILED — %d errors" % int(v.get("errors", 0)))
			_load_manifest(String(e.get("outputDirectory", _last_output_dir)))
		"manifest":
			_populate_from_manifest(result as Dictionary)


func _poll_status() -> void:
	if _current_job.is_empty():
		return
	var id: int = client.call_method("terrain.getStatus", {"jobId": _current_job})
	if id < 0:
		# Not connected any more; _abort_generation has (or will) run.
		return
	_pending[id] = "status"


func _handle_status(status: Dictionary) -> void:
	var state := String(status.get("status", ""))
	_stage_label.text = "%s  %d%%" % [String(status.get("stage", state)), int(float(status.get("progress", 0.0)) * 100.0)]
	_progress.value = float(status.get("progress", 0.0))

	match state:
		"queued", "running":
			# Re-poll shortly. Connected as a one-shot signal rather than
			# awaited: an await would resume on this dock even after the plugin
			# freed it (disable-mid-generation), erroring on a dead instance.
			# A signal connection to a freed Object is dropped automatically.
			var tree := get_tree()
			if tree != null:
				tree.create_timer(0.2).timeout.connect(_poll_status, CONNECT_ONE_SHOT)
		"complete":
			_generate_button.disabled = false
			_regenerate_button.disabled = false
			_last_output_dir = String(status.get("outputDirectory", _last_output_dir))
			_ok("generation complete → %s" % _last_output_dir)
			# Export runs validation server-side and reports both at once.
			_pending[client.call_method("terrain.export", {"outputDirectory": _last_output_dir})] = "export"
		"failed", "cancelled":
			_generate_button.disabled = false
			_regenerate_button.disabled = false
			var err: Dictionary = status.get("error", {})
			_error("generation %s: %s %s" % [state, err.get("code", ""), err.get("message", "")])


func _load_manifest(dir: String) -> void:
	_last_output_dir = dir
	_pending[client.call_method("terrain.getManifest", {"directory": dir})] = "manifest"


# ---------------------------------------------------------------- artifacts

func _populate_from_manifest(manifest: Dictionary) -> void:
	_artifacts.clear()

	var cs: Dictionary = manifest.get("coordinate_system", {})
	_coord_label.text = "%s-handed · up %s · east %s · north %s\nunits: %s\n%s" % [
		cs.get("handedness", "?"),
		cs.get("up_axis", "?"),
		cs.get("east_axis", "?"),
		cs.get("north_axis", "?"),
		cs.get("linear_unit", "?"),
		cs.get("note", ""),
	]

	var artifacts: Array = manifest.get("artifacts", [])
	var stale := 0
	var missing := 0
	for entry_variant in artifacts:
		var entry: Dictionary = entry_variant
		var rel := String(entry.get("path", ""))
		var full := _last_output_dir.path_join(rel)
		var label := "%s  (%s)" % [rel, String.humanize_size(int(entry.get("bytes", 0)))]

		# Detect stale or missing artifacts (spec §17) by size, which is cheap;
		# full checksum verification is the sidecar's `validate` pass.
		if not FileAccess.file_exists(full):
			label = "MISSING  " + label
			missing += 1
		else:
			var f := FileAccess.open(full, FileAccess.READ)
			if f != null and f.get_length() != int(entry.get("bytes", 0)):
				label = "STALE  " + label
				stale += 1
			if f != null:
				f.close()
		_artifacts.add_item(label)

	if missing > 0 or stale > 0:
		_error("%d missing, %d stale artifacts — re-export before importing" % [missing, stale])
	else:
		_info("%d artifacts verified present at the recorded sizes" % artifacts.size())


# ------------------------------------------------------------------ import

func _on_import_pressed() -> void:
	var dir := _output_edit.text.strip_edges()
	if dir.is_empty():
		dir = _last_output_dir
	if dir.is_empty():
		_error("no output directory — generate first, or type one in")
		return

	var loader: RefCounted = LoaderScript.new()
	if not loader.load_export(dir):
		for e in loader.errors:
			_error(String(e))
		return

	var parent := _import_parent()
	if parent == null:
		_error("no scene open — open or create a 3D scene to import into")
		return

	# Replace any previous import rather than stacking terrains.
	var existing := parent.get_node_or_null("LunarTerrainRoot")
	if existing != null:
		existing.queue_free()

	_terrain_root = loader.build_scene(parent)
	_assign_ownership(_terrain_root, parent)

	_populate_from_manifest(loader.manifest)
	_ok(
		"imported %d layers, %d collision regions"
		% [loader.layers.size(), _terrain_root.get_node("TerrainCollision").get_child_count()]
	)
	terrain_imported.emit(_terrain_root)


func _import_parent() -> Node:
	# In the editor the imported nodes must belong to the edited scene so they
	# are saved with it; outside it, fall back to this dock's tree root.
	if Engine.is_editor_hint():
		var edited := EditorInterface.get_edited_scene_root()
		if edited != null:
			return edited
		return null
	return get_tree().current_scene if get_tree() else null


## Nodes built at runtime are invisible in the scene tree until they are owned.
func _assign_ownership(node: Node, owner_node: Node) -> void:
	if node != owner_node:
		node.owner = owner_node
	for child in node.get_children():
		_assign_ownership(child, owner_node)


# --------------------------------------------------------------------- log

func _info(text: String) -> void:
	_log.append_text("[color=#8b939e]%s[/color]\n" % text)


func _ok(text: String) -> void:
	_log.append_text("[color=#00ff9f]%s[/color]\n" % text)


func _error(text: String) -> void:
	_log.append_text("[color=#ff5c5c]%s[/color]\n" % text)
	push_warning("lunar-terrain: %s" % text)
