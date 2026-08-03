@tool
extends EditorPlugin
## Editor plugin entry point (spec §17).
##
## Registers the terrain dock and keeps its sidecar client pumped. The dock is
## added to the left upper slot alongside the scene tree, where an import tool
## belongs.

const DockScript := preload("res://addons/lunar_terrain/dock.gd")

var _dock: Control


func _enter_tree() -> void:
	_dock = DockScript.new()
	add_control_to_dock(DOCK_SLOT_LEFT_UR, _dock)
	# The dock polls the WebSocket itself, but a Control only receives
	# _process while processing is enabled.
	_dock.set_process(true)


func _exit_tree() -> void:
	if _dock:
		if _dock.client:
			_dock.client.close()
		remove_control_from_docks(_dock)
		_dock.queue_free()
		_dock = null


func _get_plugin_name() -> String:
	return "Lunar Terrain Sidecar"
