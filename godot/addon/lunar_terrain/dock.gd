@tool
class_name LunarTerrainDock
extends VBoxContainer
## Editor dock for the lunar terrain sidecar (spec §17).
##
## Built in code rather than as a `.tscn` so the whole dock is reviewable in one
## file and cannot drift from the script that drives it.
##
## The dock covers generation/import plus the sidecar's authoritative point,
## terramechanics, solar, horizon, construction, provenance, and live-delta
## surfaces. Every displayed scientific qualifier comes from the manifest or an
## RPC response; this remains a simulation-authoring tool, never a live command
## interface.

const SidecarClientScript := preload("res://addons/lunar_terrain/sidecar_client.gd")
const LoaderScript := preload("res://addons/lunar_terrain/lunar_terrain_loader.gd")
const LiveSyncScript := preload("res://addons/lunar_terrain/terrain_live_sync.gd")

const DEFAULT_URL := "ws://127.0.0.1:8768"
const DEFAULT_UI_URL := "http://127.0.0.1:5173"
# Godot 4.6.3 exposes Control.accessibility_live as the integer enum hint
# `Off,Polite,Assertive`, but its ClassDB does not expose AccessibilityServer.
const ACCESSIBILITY_LIVE_POLITE := 1
const ACCESSIBILITY_LIVE_ASSERTIVE := 2

var client: RefCounted
var _content: VBoxContainer
var _status_dot: ColorRect
var _status_label: Label
var _mode_banner: Label
var _dataset_label: Label
var _sync_label: Label
var _url_edit: LineEdit
var _connect_button: Button
var _disconnect_button: Button
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
var _provenance_label: RichTextLabel
var _x_spin: SpinBox
var _z_spin: SpinBox
var _far_field_check: CheckBox
var _solar_mode: OptionButton
var _epoch_edit: LineEdit
var _analysis_output: RichTextLabel
var _construction_kind: OptionButton
var _radius_spin: SpinBox
var _strength_spin: SpinBox
var _heading_spin: SpinBox
var _length_spin: SpinBox
var _target_spin: SpinBox
var _mass_conserving_check: CheckBox
var _apply_operation_button: Button

var _current_job: String = ""
var _last_config: Dictionary = {}
var _last_output_dir: String = ""
var _pending: Dictionary = {}
## Node the imported terrain is parented to, so a re-import can replace it.
var _terrain_root: Node3D = null
var _loader: RefCounted = null
var _live_sync: Node = null
var _resync_head := 0
var _analysis_lines: Dictionary = {}
var _analysis_token := 0
var _analysis_heading := ""
var _sidecar_dataset: Dictionary = {}
var _imported_manifest: Dictionary = {}

signal terrain_imported(root: Node3D)


func _init() -> void:
	name = "Lunar Terrain"
	# The editor can make side docks narrower than 340 logical pixels,
	# particularly when the editor scale is 200%. Keep the dock usable at that
	# real width and let the vertically reflowed controls determine their height.
	custom_minimum_size = Vector2(260, 0)
	add_theme_constant_override("separation", 6)
	_build_ui()
	_setup_client()


func _build_ui() -> void:
	var scroll := ScrollContainer.new()
	scroll.name = "DockScroll"
	scroll.size_flags_horizontal = Control.SIZE_EXPAND_FILL
	scroll.size_flags_vertical = Control.SIZE_EXPAND_FILL
	scroll.horizontal_scroll_mode = ScrollContainer.SCROLL_MODE_DISABLED
	add_child(scroll)
	_content = VBoxContainer.new()
	_content.name = "DockContent"
	_content.size_flags_horizontal = Control.SIZE_EXPAND_FILL
	_content.add_theme_constant_override("separation", 6)
	scroll.add_child(_content)

	_mode_banner = Label.new()
	_mode_banner.text = "SIMULATION TERRAIN\nMODELLED SITE\nNOT A LIVE COMMAND INTERFACE"
	_mode_banner.autowrap_mode = TextServer.AUTOWRAP_WORD_SMART
	_mode_banner.horizontal_alignment = HORIZONTAL_ALIGNMENT_CENTER
	_mode_banner.tooltip_text = "Authoring and analysis only. Dynamics and flight/rover control remain outside this sidecar."
	_mode_banner.accessibility_name = "Simulation authority warning"
	_mode_banner.accessibility_description = _mode_banner.tooltip_text
	_content.add_child(_mode_banner)

	# ------------------------------------------------------------ connection
	_section("Sidecar")

	var status_row := HBoxContainer.new()
	_status_dot = ColorRect.new()
	_status_dot.custom_minimum_size = Vector2(10, 10)
	_status_dot.color = Color(0.55, 0.58, 0.62)
	status_row.add_child(_status_dot)
	_status_label = Label.new()
	_status_label.text = "disconnected"
	_status_label.accessibility_name = "Sidecar connection status"
	_status_label.accessibility_live = ACCESSIBILITY_LIVE_POLITE
	status_row.add_child(_status_label)
	_content.add_child(status_row)

	var endpoint_label := Label.new()
	endpoint_label.text = "WebSocket endpoint"
	_content.add_child(endpoint_label)
	_url_edit = LineEdit.new()
	_url_edit.text = DEFAULT_URL
	_url_edit.tooltip_text = "Sidecar WebSocket endpoint"
	_url_edit.accessibility_name = endpoint_label.text
	_url_edit.accessibility_description = _url_edit.tooltip_text
	_content.add_child(_url_edit)

	var conn_row := HFlowContainer.new()
	_connect_button = Button.new()
	_connect_button.text = "Connect"
	_connect_button.pressed.connect(_on_connect_pressed)
	conn_row.add_child(_connect_button)

	_disconnect_button = Button.new()
	_disconnect_button.text = "Disconnect"
	_disconnect_button.disabled = true
	_disconnect_button.pressed.connect(func() -> void: client.close())
	conn_row.add_child(_disconnect_button)

	var ui_button := Button.new()
	ui_button.text = "Open Sidecar UI"
	ui_button.tooltip_text = "Open the browser terrain authoring UI"
	ui_button.pressed.connect(func() -> void: OS.shell_open(DEFAULT_UI_URL))
	conn_row.add_child(ui_button)
	_content.add_child(conn_row)

	_dataset_label = Label.new()
	_dataset_label.text = "dataset: not inspected"
	_dataset_label.autowrap_mode = TextServer.AUTOWRAP_WORD_SMART
	_dataset_label.accessibility_name = "Sidecar dataset identity"
	_dataset_label.accessibility_live = ACCESSIBILITY_LIVE_POLITE
	_content.add_child(_dataset_label)
	_sync_label = Label.new()
	_sync_label.text = "live sync: inactive"
	_sync_label.autowrap_mode = TextServer.AUTOWRAP_WORD_SMART
	_sync_label.accessibility_name = "Live synchronization status"
	_sync_label.accessibility_live = ACCESSIBILITY_LIVE_ASSERTIVE
	_content.add_child(_sync_label)

	# --------------------------------------------------------- configuration
	_section("Configuration")

	var config_label := Label.new()
	config_label.text = "Configuration JSON"
	_content.add_child(config_label)
	_config_edit = LineEdit.new()
	_config_edit.placeholder_text = "path to config.json"
	_config_edit.size_flags_horizontal = Control.SIZE_EXPAND_FILL
	_config_edit.accessibility_name = config_label.text
	_config_edit.accessibility_description = "Validated terrain configuration JSON file"
	_content.add_child(_config_edit)
	var browse := Button.new()
	browse.text = "Browse Configuration…"
	browse.tooltip_text = "Choose a terrain configuration"
	browse.size_flags_horizontal = Control.SIZE_EXPAND_FILL
	browse.pressed.connect(_on_browse_pressed)
	_content.add_child(browse)

	var seed_label := Label.new()
	seed_label.text = "Deterministic seed override"
	_content.add_child(seed_label)
	_seed_edit = LineEdit.new()
	_seed_edit.placeholder_text = "seed (overrides the configuration)"
	_seed_edit.accessibility_name = seed_label.text
	_seed_edit.accessibility_description = "Explicit deterministic seed; blank uses the configuration seed"
	_content.add_child(_seed_edit)

	var output_label := Label.new()
	output_label.text = "Export directory"
	_content.add_child(output_label)
	_output_edit = LineEdit.new()
	_output_edit.placeholder_text = "output directory (from the configuration)"
	_output_edit.accessibility_name = output_label.text
	_output_edit.accessibility_description = "Directory for validated terrain artifacts"
	_content.add_child(_output_edit)

	# ----------------------------------------------------------- generation
	_section("Generation")

	var gen_row := HFlowContainer.new()
	_generate_button = Button.new()
	_generate_button.text = "Generate"
	_generate_button.pressed.connect(_on_generate_pressed)
	gen_row.add_child(_generate_button)

	_regenerate_button = Button.new()
	_regenerate_button.text = "Regenerate"
	_regenerate_button.tooltip_text = "Re-run the last validated configuration with the explicit seed shown above"
	_regenerate_button.pressed.connect(_on_regenerate_pressed)
	gen_row.add_child(_regenerate_button)

	_import_button = Button.new()
	_import_button.text = "Import"
	_import_button.tooltip_text = "Build scene nodes from the exported artifacts"
	_import_button.pressed.connect(_on_import_pressed)
	gen_row.add_child(_import_button)
	_content.add_child(gen_row)

	_progress = ProgressBar.new()
	_progress.min_value = 0.0
	_progress.max_value = 1.0
	_progress.value = 0.0
	_progress.show_percentage = true
	_progress.accessibility_name = "Terrain generation progress"
	_content.add_child(_progress)

	_stage_label = Label.new()
	_stage_label.text = "idle"
	_stage_label.autowrap_mode = TextServer.AUTOWRAP_WORD_SMART
	_stage_label.accessibility_name = "Generation stage"
	_stage_label.accessibility_live = ACCESSIBILITY_LIVE_POLITE
	_content.add_child(_stage_label)

	# ------------------------------------------------------------- artifacts
	_section("Artifacts")
	_artifacts = ItemList.new()
	_artifacts.custom_minimum_size = Vector2(0, 130)
	_artifacts.size_flags_vertical = Control.SIZE_EXPAND_FILL
	_artifacts.accessibility_name = "Exported artifacts and checksum status"
	_artifacts.add_item("No exported artifacts loaded.")
	_content.add_child(_artifacts)

	# ------------------------------------------------------ coordinate system
	_section("Coordinate system")
	_coord_label = Label.new()
	_coord_label.text = "(import a terrain to read its declared frame)"
	_coord_label.autowrap_mode = TextServer.AUTOWRAP_WORD_SMART
	_content.add_child(_coord_label)

	# ----------------------------------------------------------- provenance
	_section("Data provenance")
	_provenance_label = RichTextLabel.new()
	_provenance_label.name = "Provenance"
	_provenance_label.custom_minimum_size = Vector2(0, 120)
	_provenance_label.fit_content = true
	_provenance_label.autowrap_mode = TextServer.AUTOWRAP_WORD_SMART
	_provenance_label.tooltip_text = "Measurement/model provenance declared by the loaded dataset"
	_provenance_label.accessibility_name = "Terrain data provenance"
	_provenance_label.text = "No terrain provenance loaded."
	_content.add_child(_provenance_label)

	_build_analysis_ui()
	_build_construction_ui()

	# ------------------------------------------------------------------- log
	_section("Validation / log")
	_log = RichTextLabel.new()
	_log.custom_minimum_size = Vector2(0, 130)
	_log.size_flags_vertical = Control.SIZE_EXPAND_FILL
	_log.bbcode_enabled = false
	_log.scroll_following = true
	_log.accessibility_name = "Validation and event log"
	_log.accessibility_live = ACCESSIBILITY_LIVE_POLITE
	_log.text = "INFO · No validation or generation events yet."
	_content.add_child(_log)


func _build_analysis_ui() -> void:
	_section("Site analysis")
	var note := Label.new()
	note.text = "Queries the sidecar at local +X east / +Z south coordinates."
	note.autowrap_mode = TextServer.AUTOWRAP_WORD_SMART
	_content.add_child(note)

	var form := VBoxContainer.new()
	form.add_theme_constant_override("separation", 4)
	_x_spin = _make_spin(-10_000_000.0, 10_000_000.0, 0.0, 0.1, " m")
	_add_labelled_control(form, "X east", _x_spin, "Local east coordinate in metres")
	_z_spin = _make_spin(-10_000_000.0, 10_000_000.0, 0.0, 0.1, " m")
	_add_labelled_control(form, "Z south", _z_spin, "Local south coordinate in metres; north is negative Z")

	_solar_mode = OptionButton.new()
	_solar_mode.add_item("Analytic ephemeris")
	_solar_mode.set_item_metadata(0, "ephemeris")
	_solar_mode.add_item("JPL DE440 kernels")
	_solar_mode.set_item_metadata(1, "ephemeris_de")
	_solar_mode.size_flags_horizontal = Control.SIZE_EXPAND_FILL
	_add_labelled_control(
		form,
		"Solar model",
		_solar_mode,
		"DE440 is kernel-backed and fails explicitly when the configured kernels are unavailable"
	)

	_epoch_edit = LineEdit.new()
	_epoch_edit.placeholder_text = "ISO-8601 UTC; blank = current UTC"
	_epoch_edit.tooltip_text = "Solar query epoch. The response always reports the instant actually used."
	_add_labelled_control(form, "Epoch UTC", _epoch_edit, _epoch_edit.tooltip_text)

	_far_field_check = CheckBox.new()
	_far_field_check.text = "Use real LDEM_75S far field"
	_far_field_check.tooltip_text = "Requires the real LOLA LDEM_75S product; failure never falls back silently"
	_far_field_check.accessibility_name = "Merge real LDEM_75S far field"
	_far_field_check.accessibility_description = _far_field_check.tooltip_text
	form.add_child(_far_field_check)
	_content.add_child(form)

	var actions := HFlowContainer.new()
	var inspect_button := Button.new()
	inspect_button.text = "Inspect Point"
	inspect_button.tooltip_text = "Query elevation, semantic class, Bekker–Wong screening, and solar geometry"
	inspect_button.pressed.connect(_on_inspect_point_pressed)
	actions.add_child(inspect_button)
	var horizon_button := Button.new()
	horizon_button.text = "Compute Horizon"
	horizon_button.tooltip_text = "Compute the 360-bin skyline at this point"
	horizon_button.pressed.connect(_on_horizon_pressed)
	actions.add_child(horizon_button)
	_content.add_child(actions)

	_analysis_output = RichTextLabel.new()
	_analysis_output.name = "AnalysisOutput"
	_analysis_output.custom_minimum_size = Vector2(0, 150)
	_analysis_output.fit_content = true
	_analysis_output.autowrap_mode = TextServer.AUTOWRAP_WORD_SMART
	_analysis_output.text = "No site query has run."
	_analysis_output.accessibility_name = "Site analysis results"
	_analysis_output.accessibility_live = ACCESSIBILITY_LIVE_POLITE
	_content.add_child(_analysis_output)


func _build_construction_ui() -> void:
	_section("Simulated construction")
	var warning := Label.new()
	warning.text = "Edits mutate the sidecar dataset and the imported simulation terrain; they do not command hardware."
	warning.autowrap_mode = TextServer.AUTOWRAP_WORD_SMART
	warning.accessibility_name = "Simulated construction warning"
	_content.add_child(warning)

	var form := VBoxContainer.new()
	form.add_theme_constant_override("separation", 4)
	_construction_kind = OptionButton.new()
	for kind in ["trench", "berm", "ramp", "pad", "spoil_pile", "wheel_track"]:
		_construction_kind.add_item(String(kind).replace("_", " ").capitalize())
		_construction_kind.set_item_metadata(_construction_kind.item_count - 1, kind)
	_construction_kind.size_flags_horizontal = Control.SIZE_EXPAND_FILL
	_construction_kind.item_selected.connect(_on_construction_kind_selected)
	_add_labelled_control(form, "Feature", _construction_kind, "Implemented construction operation recorded in the feature manifest")

	_radius_spin = _make_spin(0.01, 100_000.0, 5.0, 0.1, " m")
	_add_labelled_control(form, "Radius / half-width", _radius_spin, "Feature radius; wheel track uses this as gauge")
	_strength_spin = _make_spin(0.0, 10_000.0, 0.25, 0.01, " m")
	_add_labelled_control(form, "Depth / height", _strength_spin, "Magnitude of cut, fill, pile height, or rut depth")
	_heading_spin = _make_spin(0.0, 359.9, 0.0, 0.1, "°")
	_add_labelled_control(form, "Heading", _heading_spin, "Clockwise from north; north is -Z")
	_length_spin = _make_spin(0.01, 100_000.0, 20.0, 0.1, " m")
	_add_labelled_control(form, "Length", _length_spin, "Used by trench, berm, ramp, pad, and wheel track")
	_target_spin = _make_spin(-100_000.0, 100_000.0, 0.0, 0.01, " m")
	_add_labelled_control(form, "Target local Y", _target_spin, "Absolute target elevation used by ramp and pad")

	_mass_conserving_check = CheckBox.new()
	_mass_conserving_check.text = "Mass-conserving redistribution"
	_mass_conserving_check.tooltip_text = "Deposits or borrows material in the operation's measured redistribution ring"
	_mass_conserving_check.accessibility_name = "Redistribute material in mass-conserving mode"
	_mass_conserving_check.accessibility_description = _mass_conserving_check.tooltip_text
	form.add_child(_mass_conserving_check)
	_content.add_child(form)

	_apply_operation_button = Button.new()
	_apply_operation_button.text = "Apply Simulated Edit"
	_apply_operation_button.tooltip_text = "Mutates the current sidecar dataset, records an auditable operation, and live-syncs affected Godot chunks"
	_apply_operation_button.accessibility_name = "Apply simulated terrain edit"
	_apply_operation_button.disabled = true
	_apply_operation_button.size_flags_horizontal = Control.SIZE_EXPAND_FILL
	_apply_operation_button.pressed.connect(_on_apply_operation_pressed)
	_content.add_child(_apply_operation_button)
	_on_construction_kind_selected(_construction_kind.selected)


func _on_construction_kind_selected(index: int) -> void:
	var kind := String(_construction_kind.get_item_metadata(index))
	var directional := kind in ["trench", "berm", "ramp", "pad", "wheel_track"]
	_heading_spin.editable = directional
	_length_spin.editable = directional
	_target_spin.editable = kind == "ramp" or kind == "pad"


func _make_spin(
	minimum: float, maximum: float, initial: float, increment: float, unit_suffix: String
) -> SpinBox:
	var spin := SpinBox.new()
	spin.min_value = minimum
	spin.max_value = maximum
	spin.value = initial
	spin.step = increment
	spin.suffix = unit_suffix
	spin.allow_greater = false
	spin.allow_lesser = false
	spin.size_flags_horizontal = Control.SIZE_EXPAND_FILL
	return spin


func _add_labelled_control(
	form: Container, label_text: String, control: Control, tooltip: String
) -> void:
	var label := Label.new()
	label.text = label_text
	label.tooltip_text = tooltip
	control.tooltip_text = tooltip
	control.accessibility_name = label_text
	control.accessibility_description = tooltip
	form.add_child(label)
	form.add_child(control)


func _section(title: String) -> void:
	var sep := HSeparator.new()
	_content.add_child(sep)
	var label := Label.new()
	label.text = title.to_upper()
	label.accessibility_name = "%s section" % title
	_content.add_child(label)


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
	_set_connection_controls("connecting")
	_set_status("connecting", Color(1.0, 0.77, 0.0))
	client.connect_to_sidecar(_url_edit.text)


func _on_connected() -> void:
	_set_connection_controls("connected")
	_set_status("connected", Color(0.0, 1.0, 0.62))
	_info("connected to %s" % _url_edit.text)
	_call("health", "terrain.health")
	_call("capabilities", "terrain.capabilities")
	if _loader != null and _terrain_root != null:
		_setup_live_sync()


func _on_disconnected() -> void:
	_set_connection_controls("disconnected")
	_set_status("disconnected", Color(0.55, 0.58, 0.62))
	_info("disconnected")
	if _live_sync != null:
		_live_sync.stop()
	_sync_label.text = "live sync: disconnected"
	_apply_operation_button.disabled = true
	_abort_generation("sidecar disconnected")


func _on_connection_failed(reason: String) -> void:
	_set_connection_controls("disconnected")
	_set_status("unreachable", Color(1.0, 0.36, 0.36))
	_sync_label.text = "live sync: sidecar unreachable"
	_apply_operation_button.disabled = true
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


func _set_connection_controls(state: String) -> void:
	var disconnected := state == "disconnected"
	_connect_button.disabled = not disconnected
	_disconnect_button.disabled = disconnected
	_url_edit.editable = disconnected


func _call(
	kind: String,
	method: String,
	params: Dictionary = {},
	context: Dictionary = {}
) -> int:
	var id: int = client.call_method(method, params)
	if id < 0:
		_error("%s could not be sent: %s" % [method, client.last_error])
		return id
	var pending_context := context.duplicate(true)
	pending_context["kind"] = kind
	_pending[id] = pending_context
	return id


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
	dialog.canceled.connect(dialog.queue_free)
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
	_generate_button.disabled = true
	_regenerate_button.disabled = true
	if _call("loadConfig", "terrain.loadConfig", {"path": path}) < 0:
		_generate_button.disabled = false
		_regenerate_button.disabled = false
		return
	_info("loading %s" % path)


func _on_regenerate_pressed() -> void:
	if _last_config.is_empty():
		_error("nothing to regenerate — run Generate first")
		return
	var config := _last_config.duplicate(true)
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
	# The accepted generation request replaces the server authority. Do not
	# keep presenting the previous dataset/revision while that replacement is
	# queued or running; the imported scene is shown separately below as stale.
	_sidecar_dataset.clear()
	_render_dataset_identity()

	_progress.value = 0.0
	_stage_label.text = "queued"
	_generate_button.disabled = true
	_regenerate_button.disabled = true
	_apply_operation_button.disabled = true
	if _live_sync != null:
		_live_sync.stop()
	_sync_label.text = "live sync: imported scene is stale while a new authority is generated"
	if _terrain_root != null and is_instance_valid(_terrain_root):
		_terrain_root.set_meta("live_sync_state", "stale_generation")
	if _call("generate", "terrain.generate", {"config": config}) < 0:
		_generate_button.disabled = false
		_regenerate_button.disabled = false
		_stage_label.text = "failed to queue"


func _on_progress(job_id: String, stage: String, fraction: float, detail: String) -> void:
	if job_id != _current_job and not _current_job.is_empty():
		return
	_progress.value = fraction
	_stage_label.text = "%s  %d%%%s" % [stage, int(fraction * 100.0), (" · " + detail) if not detail.is_empty() else ""]


func _on_response(id: int, result: Variant, error: Dictionary) -> void:
	# The live synchronizer shares this client and owns its own request ids.
	# Ignore those responses here so an expected sync error cannot be mistaken
	# for a generation failure by the dock.
	if not _pending.has(id):
		return
	var context: Dictionary = _pending.get(id, {}) as Dictionary
	var kind := String(context.get("kind", ""))
	_pending.erase(id)
	if (kind.begins_with("analysis_") or kind == "horizon") and int(
		context.get("analysis_token", -1)
	) != _analysis_token:
		return

	if not error.is_empty():
		if kind == "loadConfig" or kind == "generate" or kind == "status" or kind == "export":
			_generate_button.disabled = false
			_regenerate_button.disabled = false
			_stage_label.text = "failed"
		if kind == "operation":
			_apply_operation_button.disabled = false
		if kind.begins_with("analysis_") or kind == "horizon":
			_analysis_lines[kind] = "Query failed: %s" % SidecarClientScript.describe_error(error)
			_render_analysis()
		if kind == "resync_export":
			_sync_label.text = "live sync: resync export failed"
		_error("%s: %s" % [kind, SidecarClientScript.describe_error(error)])
		return

	match kind:
		"health":
			var h: Dictionary = result
			_info(
				"protocol %s · generator %s" % [h.get("protocolVersion", "?"), h.get("generatorVersion", "?")]
			)
			if bool(h.get("datasetLoaded", false)):
				_call("dataset", "terrain.getDataset")
			else:
				_sidecar_dataset.clear()
				_render_dataset_identity()
		"capabilities":
			var caps: Dictionary = result
			var sync: Dictionary = caps.get("sync", {})
			_sync_label.text = "live sync: inactive · sparse cap %s · retained deltas %s" % [
				sync.get("sparseSampleCap", "?"), sync.get("deltaWindow", "?")
			]
		"dataset":
			_populate_from_dataset(result as Dictionary)
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
			_handle_export(result as Dictionary, false)
		"resync_export":
			_handle_export(result as Dictionary, true)
		"manifest":
			_populate_from_manifest(result as Dictionary)
		"analysis_height":
			_record_height(result as Dictionary)
		"analysis_semantic":
			_record_semantic(result as Dictionary)
		"analysis_traversability":
			_record_traversability(result as Dictionary)
		"analysis_solar":
			_record_solar(result as Dictionary)
		"horizon":
			_record_horizon(result as Dictionary)
		"operation":
			_handle_operation(result as Dictionary)


func _poll_status() -> void:
	if _current_job.is_empty():
		return
	var id := _call("status", "terrain.getStatus", {"jobId": _current_job})
	if id < 0:
		_abort_generation("status request could not be sent: %s" % client.last_error)
		return


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
			_last_output_dir = String(status.get("outputDirectory", _last_output_dir))
			_stage_label.text = "validating export"
			_ok("generation complete; validating export → %s" % _last_output_dir)
			# Export runs validation server-side and reports both at once.
			if _call("export", "terrain.export", {"outputDirectory": _last_output_dir}) < 0:
				_abort_generation("export request could not be sent: %s" % client.last_error)
		"failed", "cancelled":
			_generate_button.disabled = false
			_regenerate_button.disabled = false
			var err: Dictionary = status.get("error", {})
			_error("generation %s: %s %s" % [state, err.get("code", ""), err.get("message", "")])


func _load_manifest(dir: String) -> void:
	_last_output_dir = dir
	_call("manifest", "terrain.getManifest", {"directory": dir})


func _handle_export(export_result: Dictionary, resync: bool) -> void:
	var validation: Dictionary = export_result.get("validation", {})
	if not bool(validation.get("passed", false)):
		if not resync:
			_generate_button.disabled = false
			_regenerate_button.disabled = false
			_stage_label.text = "validation failed"
		_error("validation FAILED — %d errors" % int(validation.get("errors", 0)))
		if resync:
			_sync_label.text = "live sync: full resync validation failed"
		return
	_ok("validation PASSED — %d artifacts, %.1f MB" % [
		int(export_result.get("artifacts", 0)), float(export_result.get("totalBytes", 0)) / 1e6
	])
	var output := String(export_result.get("outputDirectory", _last_output_dir))
	if resync:
		_sync_label.text = "live sync: validated export ready; rebuilding imported scene"
		_output_edit.text = output
		_on_import_pressed()
	else:
		_generate_button.disabled = false
		_regenerate_button.disabled = false
		_stage_label.text = "complete · validation passed"
		_load_manifest(output)
		# Generation installs a new dataset revision. Refresh its identity from
		# the authority rather than leaving the panel blank or showing the prior
		# generation until the next reconnect.
		_call("dataset", "terrain.getDataset")


# ---------------------------------------------------------- live inspection

func _on_inspect_point_pressed() -> void:
	if not client.is_connected_to_sidecar():
		_error("point inspection requires a connected sidecar")
		return
	_analysis_token += 1
	_analysis_lines.clear()
	var x := _x_spin.value
	var z := _z_spin.value
	var mode := String(_solar_mode.get_item_metadata(_solar_mode.selected))
	var epoch := _epoch_edit.text.strip_edges()
	_analysis_heading = "Point query · X %.3f m east · Z %.3f m south · solar %s%s" % [
		x,
		z,
		mode,
		(" · epoch " + epoch) if not epoch.is_empty() else " · sidecar default epoch",
	]
	_analysis_output.text = "%s\n\nQuerying authoritative dataset values…" % _analysis_heading
	var context := {"analysis_token": _analysis_token, "x": x, "z": z}
	var point := {"x": x, "z": z}
	_call("analysis_height", "terrain.getHeight", point, context)
	_call("analysis_semantic", "terrain.getSemanticClass", point, context)
	_call(
		"analysis_traversability",
		"terrain.getTraversability",
		{"x": x, "z": z, "model": "bekker"},
		context
	)
	var solar := {
		"x": x,
		"z": z,
		"mode": mode,
	}
	if not epoch.is_empty():
		solar["epochUtc"] = epoch
	_call("analysis_solar", "terrain.getSolar", solar, context)


func _on_horizon_pressed() -> void:
	if not client.is_connected_to_sidecar():
		_error("horizon analysis requires a connected sidecar")
		return
	_analysis_token += 1
	_analysis_lines.clear()
	var x := _x_spin.value
	var z := _z_spin.value
	var far_field := _far_field_check.button_pressed
	_analysis_heading = "Horizon query · X %.3f m east · Z %.3f m south · %s" % [
		x,
		z,
		"near field + real LDEM_75S" if far_field else "near field only",
	]
	_analysis_lines["horizon"] = "Computing 360-bin horizon…"
	_render_analysis()
	_call(
		"horizon",
		"terrain.getHorizon",
		{
			"x": x,
			"z": z,
			"azimuthBins": 360,
			"farField": far_field,
		},
		{"analysis_token": _analysis_token, "x": x, "z": z}
	)


func _record_height(result: Dictionary) -> void:
	_analysis_lines["analysis_height"] = "Elevation: %.3f m local Y · layer %s · datum %.3f m" % [
		float(result.get("elevationM", NAN)),
		String(result.get("layerId", "outside dataset")),
		float(result.get("datumElevationM", NAN)),
	]
	_render_analysis()


func _record_semantic(result: Dictionary) -> void:
	_analysis_lines["analysis_semantic"] = "Semantic class: %s · index %s · layer %s" % [
		String(result.get("semanticClass", "none")),
		String(result.get("index", "none")),
		String(result.get("layerId", "outside dataset")),
	]
	_render_analysis()


func _record_traversability(result: Dictionary) -> void:
	var value: Variant = result.get("traversability", null)
	if typeof(value) != TYPE_DICTIONARY:
		_analysis_lines["analysis_traversability"] = "Terramechanics: no covering layer at this point"
		_render_analysis()
		return
	var assessment: Dictionary = value
	var line := "Terramechanics (%s): %s · slope %.2f° · sinkage %.4f m · drawbar %.1f N" % [
		String(assessment.get("model", "unknown model")),
		String(assessment.get("class", "unknown")),
		float(assessment.get("slopeDeg", NAN)),
		float(assessment.get("sinkageM", NAN)),
		float(assessment.get("drawbarPullN", NAN)),
	]
	var parameters: Dictionary = assessment.get("parameters", {})
	var provenance: Dictionary = parameters.get("provenance", {})
	if not provenance.is_empty():
		line += "\nApplicability: %s\nScope: %s" % [
			provenance.get("siteApplicability", "not declared"),
			provenance.get("scope", "not declared"),
		]
	_analysis_lines["analysis_traversability"] = line
	_render_analysis()


func _record_solar(result: Dictionary) -> void:
	_analysis_lines["analysis_solar"] = "Solar (%s at %s): elevation %.4f° · azimuth %.4f° · disc above geometric horizon %.3f" % [
		String(result.get("model", "unknown")),
		String(result.get("epochUtc", "unknown epoch")),
		float(result.get("elevationDeg", NAN)),
		float(result.get("azimuthDeg", NAN)),
		float(result.get("discFractionAboveHorizon", NAN)),
	]
	_render_analysis()


func _record_horizon(result: Dictionary) -> void:
	var elevations: Array = result.get("horizonElevationDeg", [])
	var minimum := INF
	var maximum := -INF
	for value in elevations:
		minimum = minf(minimum, float(value))
		maximum = maxf(maximum, float(value))
	var far: Dictionary = result.get("farField", {})
	var source := "near field only"
	if bool(far.get("applied", false)):
		source = "near field merged with real LDEM_75S"
	_analysis_lines["horizon"] = "Horizon: %d bins · %.4f° to %.4f° · %s\n%s" % [
		int(result.get("bins", elevations.size())), minimum, maximum, source, result.get("note", "")
	]
	_render_analysis()


func _render_analysis() -> void:
	var lines := PackedStringArray()
	if not _analysis_heading.is_empty():
		lines.append(_analysis_heading)
	for key in [
		"analysis_height",
		"analysis_semantic",
		"analysis_traversability",
		"analysis_solar",
		"horizon",
	]:
		if _analysis_lines.has(key):
			lines.append(String(_analysis_lines[key]))
	_analysis_output.text = "\n\n".join(lines) if not lines.is_empty() else "No site query has run."


# ---------------------------------------------------------------- artifacts

func _populate_from_dataset(dataset: Dictionary) -> void:
	_sidecar_dataset = dataset.duplicate(true)
	_render_dataset_identity()


func _populate_from_manifest(manifest: Dictionary, imported_scene := false) -> void:
	_artifacts.clear()
	if imported_scene:
		_imported_manifest = manifest.duplicate(true)
		_render_dataset_identity()
	elif _imported_manifest.is_empty():
		_provenance_label.text = "VALIDATED EXPORT\n" + _format_provenance(
			String(manifest.get("terrainId", "unnamed")),
			String(manifest.get("seed", "not declared")),
			manifest.get("layers", []) as Array,
			manifest.get("provenance", {}) as Dictionary
		)

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


func _render_dataset_identity() -> void:
	var identity_lines := PackedStringArray()
	var provenance_sections := PackedStringArray()
	if _sidecar_dataset.is_empty():
		identity_lines.append("sidecar authority: no dataset loaded or inspected")
	else:
		identity_lines.append(
			"sidecar authority: %s · seed %s · revision %s · %d layers"
			% [
				_sidecar_dataset.get("terrainId", "unnamed"),
				_sidecar_dataset.get("seed", "not declared"),
				_sidecar_dataset.get("datasetRevision", "not declared"),
				(_sidecar_dataset.get("layers", []) as Array).size(),
			]
		)
		provenance_sections.append(
			"SIDECAR AUTHORITY\n" + _format_provenance(
				String(_sidecar_dataset.get("terrainId", "unnamed")),
				String(_sidecar_dataset.get("seed", "not declared")),
				_sidecar_dataset.get("layers", []) as Array,
				_sidecar_dataset.get("provenance", {}) as Dictionary
			)
		)
	if _imported_manifest.is_empty():
		identity_lines.append("imported scene: none")
	else:
		identity_lines.append(
			"imported scene: %s · seed %s · %d layers"
			% [
				_imported_manifest.get("terrainId", "unnamed"),
				_imported_manifest.get("seed", "not declared"),
				(_imported_manifest.get("layers", []) as Array).size(),
			]
		)
		provenance_sections.append(
			"IMPORTED SCENE\n" + _format_provenance(
				String(_imported_manifest.get("terrainId", "unnamed")),
				String(_imported_manifest.get("seed", "not declared")),
				_imported_manifest.get("layers", []) as Array,
				_imported_manifest.get("provenance", {}) as Dictionary
			)
		)
	if not _sidecar_dataset.is_empty() and not _imported_manifest.is_empty():
		var labels_match := (
			String(_sidecar_dataset.get("terrainId", ""))
			== String(_imported_manifest.get("terrainId", ""))
			and String(_sidecar_dataset.get("seed", ""))
			== String(_imported_manifest.get("seed", ""))
		)
		identity_lines.append(
			"label identity: %s · edit enablement also requires the live checksum handshake"
			% ("MATCH" if labels_match else "MISMATCH")
		)
	_dataset_label.text = "\n".join(identity_lines)
	_provenance_label.text = (
		"\n\n".join(provenance_sections)
		if not provenance_sections.is_empty()
		else "No terrain provenance loaded."
	)


func _format_provenance(
	terrain_id: String, seed: String, layer_records: Array, provenance: Dictionary
) -> String:
	var lines := PackedStringArray([
		"Terrain: %s" % terrain_id,
		"Deterministic master seed: %s" % seed,
	])
	for layer_variant in layer_records:
		if typeof(layer_variant) != TYPE_DICTIONARY:
			continue
		var layer: Dictionary = layer_variant
		var resolution: Variant = layer.get("resolutionMeters", layer.get("resolution_m", "?"))
		var source_resolution: Variant = layer.get(
			"sourceEffectiveResolutionMeters", layer.get("source_effective_resolution_m", "not declared")
		)
		var elevation_provenance: Variant = layer.get(
			"elevationProvenance", layer.get("elevation_provenance", "not declared")
		)
		lines.append(
			"Layer %s (%s): %s m grid · elevation %s · source effective resolution %s m"
			% [
				layer.get("id", "unnamed"),
				layer.get("role", "unclassified"),
				resolution,
				elevation_provenance,
				source_resolution,
			]
		)

	var data_sources: Array = provenance.get("dataSources", [])
	if not data_sources.is_empty():
		lines.append("Measured data sources:")
		for source_variant in data_sources:
			if typeof(source_variant) != TYPE_DICTIONARY:
				continue
			var source: Dictionary = source_variant
			lines.append("• %s — %s" % [source.get("id", "unnamed"), source.get("citation", source.get("description", "citation not declared"))])

	var heuristics: Array = provenance.get("syntheticHeuristics", [])
	if not heuristics.is_empty():
		lines.append("Declared modelled / heuristic components:")
		for description in heuristics:
			lines.append("• %s" % description)

	var limitations: Array = provenance.get("limitations", [])
	if not limitations.is_empty():
		lines.append("Declared limitations:")
		for limitation in limitations:
			lines.append("• %s" % limitation)
	return "\n".join(lines)


# ------------------------------------------------------------------ import

func _on_import_pressed() -> void:
	var dir := _output_edit.text.strip_edges()
	if dir.is_empty():
		dir = _last_output_dir
	if dir.is_empty():
		_error("no output directory — generate first, or type one in")
		return
	_import_button.disabled = true
	_stage_label.text = "loading export metadata and rasters"

	# Stage the entire candidate without touching the currently imported scene.
	# A malformed export or failed build must leave the known-good terrain and
	# its synchronizer intact.
	var candidate_loader: RefCounted = LoaderScript.new()
	if not candidate_loader.load_export(dir):
		for e in candidate_loader.errors:
			_error(String(e))
		_import_button.disabled = false
		_stage_label.text = "import failed"
		return

	var parent := _import_parent()
	if parent == null:
		_error("no scene open — open or create a 3D scene to import into")
		_import_button.disabled = false
		_stage_label.text = "import failed"
		return

	var staging := Node3D.new()
	staging.name = "LunarTerrainImportStaging"
	parent.add_child(staging)
	_stage_label.text = "building terrain incrementally"
	var candidate_root: Node3D = await candidate_loader.build_scene_async(staging, 4)
	if candidate_root == null:
		for e in candidate_loader.errors:
			_error(String(e))
		staging.free()
		_import_button.disabled = false
		_stage_label.text = "import failed"
		return

	# Commit only after the candidate is complete. The editor marks the scene
	# unsaved; the source export remains unchanged and can always be re-imported.
	if _live_sync != null:
		_live_sync.stop()
	var existing := parent.get_node_or_null("LunarTerrainRoot")
	if existing != null:
		existing.free()
	candidate_root.reparent(parent)
	staging.free()
	candidate_root.name = "LunarTerrainRoot"
	_loader = candidate_loader
	_last_output_dir = dir
	_terrain_root = candidate_root
	_assign_ownership(_terrain_root, parent)
	if Engine.is_editor_hint():
		EditorInterface.mark_scene_as_unsaved()

	_populate_from_manifest(_loader.manifest, true)
	_import_button.disabled = false
	_stage_label.text = "import complete"
	_ok(
		"imported %d layers, %d collision regions"
		% [_loader.layers.size(), _terrain_root.get_node("TerrainCollision").get_child_count()]
	)
	_setup_live_sync()
	terrain_imported.emit(_terrain_root)


func _setup_live_sync() -> void:
	if not client.is_connected_to_sidecar():
		_sync_label.text = "live sync: imported offline; connect to synchronize"
		_apply_operation_button.disabled = true
		return
	if _live_sync == null or not is_instance_valid(_live_sync):
		_live_sync = LiveSyncScript.new()
		_live_sync.name = "LunarTerrainLiveSync"
		add_child(_live_sync)
		_live_sync.state_changed.connect(_on_sync_state_changed)
		_live_sync.delta_applied.connect(_on_sync_delta_applied)
		_live_sync.resync_required.connect(_on_sync_resync_required)
		_live_sync.sync_failed.connect(_on_sync_failed)
	_live_sync.configure(client, _loader, _terrain_root, _resync_head)
	_apply_operation_button.disabled = true
	_live_sync.start()
	_resync_head = 0


func _on_sync_state_changed(state: String, detail: String) -> void:
	_sync_label.text = "live sync: %s · %s" % [state, detail]
	_apply_operation_button.disabled = (
		state != "current" or not client.is_connected_to_sidecar()
	)


func _on_sync_delta_applied(sequence_number: int, delta_id: String, changed_samples: int) -> void:
	_sync_label.text = "live sync: applied %s at sequence %d via %s · %d height samples · %s visual / %s collision chunks" % [
		delta_id,
		sequence_number,
		_live_sync.last_transport,
		changed_samples,
		_live_sync.last_refresh.get("visual_chunks", "?"),
		_live_sync.last_refresh.get("collision_chunks", "?"),
	]
	_info("live delta %s applied to affected Godot chunks" % delta_id)


func _on_sync_resync_required(head_sequence: int, reason: String) -> void:
	_apply_operation_button.disabled = true
	_resync_head = head_sequence
	_sync_label.text = "live sync: full validated resync required · %s" % reason
	_error("live sync requested a full resync: %s" % reason)
	if _last_output_dir.is_empty():
		_error("full resync cannot run because no export directory is associated with this import")
		return
	_call("resync_export", "terrain.export", {"outputDirectory": _last_output_dir})


func _on_sync_failed(reason: String) -> void:
	_apply_operation_button.disabled = true
	_sync_label.text = "live sync: stopped with error · %s" % reason
	_error("live sync stopped: %s" % reason)


func _on_apply_operation_pressed() -> void:
	if not client.is_connected_to_sidecar():
		_error("a construction edit requires a connected sidecar")
		return
	if _loader == null or _terrain_root == null or _live_sync == null or not _live_sync.active:
		_error("import and synchronize the current dataset before applying a construction edit")
		return
	var kind := String(_construction_kind.get_item_metadata(_construction_kind.selected))
	var operation := {
		"kind": kind,
		"centerXMeters": _x_spin.value,
		"centerZMeters": _z_spin.value,
		"radiusMeters": _radius_spin.value,
		"strengthMeters": _strength_spin.value,
		"falloff": 2.0,
		"massConserving": _mass_conserving_check.button_pressed,
	}
	if kind in ["trench", "berm", "ramp", "pad", "wheel_track"]:
		operation["headingDegrees"] = _heading_spin.value
		operation["lengthMeters"] = _length_spin.value
	if kind == "ramp" or kind == "pad":
		operation["targetElevationMeters"] = _target_spin.value
	if _call("operation", "terrain.applyOperation", {"operation": operation}) >= 0:
		_apply_operation_button.disabled = true
		_sync_label.text = "live sync: construction edit submitted; awaiting authoritative delta"


func _handle_operation(result: Dictionary) -> void:
	var delta: Dictionary = result.get("delta", {})
	var mass: Dictionary = delta.get("massBalance", {})
	_ok("operation %s accepted · sequence %s · removed %.3f m³ · deposited %.3f m³" % [
		(result.get("operation", {}) as Dictionary).get("kind", "unknown"),
		delta.get("sequenceNumber", "?"),
		float(mass.get("removedVolumeM3", 0.0)),
		float(mass.get("depositedVolumeM3", 0.0)),
	])
	if result.has("reposeClamp"):
		_info("spoil-pile height was repose-clamped: %s" % JSON.stringify(result.get("reposeClamp")))
	if result.has("aliasingWarning"):
		_error(String(result.get("aliasingWarning")))
	if delta.is_empty():
		_apply_operation_button.disabled = false
		_error("operation response contained no delta; local terrain was not changed")
		return
	_live_sync.accept_delta(delta)


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
	_append_log("INFO", Color(0.65, 0.69, 0.75), text)


func _ok(text: String) -> void:
	_append_log("PASS", Color(0.0, 1.0, 0.62), text)


func _error(text: String) -> void:
	_append_log("ERROR", Color(1.0, 0.36, 0.36), text)
	push_warning("lunar-terrain: %s" % text)


func _append_log(level: String, color: Color, text: String) -> void:
	_log.push_color(color)
	_log.add_text("%s · " % level)
	_log.pop()
	_log.add_text(text + "\n")
