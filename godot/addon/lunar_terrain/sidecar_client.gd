class_name LunarSidecarClient
extends RefCounted
## JSON-RPC 2.0 client for the terrain sidecar (spec §16, §17).
##
## Speaks the same protocol as the browser UI over `WebSocketPeer`, so the Godot
## editor can drive terrain generation directly: submit a configuration, watch
## progress, then import the artifacts the sidecar wrote.
##
## Polling is explicit rather than threaded — `poll()` must be called from a
## frame callback — because Godot's WebSocketPeer is not thread-safe and an
## editor plugin has a frame loop anyway.

signal sidecar_connected()
signal sidecar_disconnected()
signal connection_failed(reason: String)
## Emitted for every `terrain.progress` notification the sidecar pushes.
signal progress(job_id: String, stage: String, fraction: float, detail: String)
## Emitted when a request completes. `error` is empty on success.
signal response(id: int, result: Variant, error: Dictionary)

enum State { DISCONNECTED, CONNECTING, CONNECTED }

## Protocol major version this client speaks. A sidecar answering with a
## different major is disconnected immediately — the protocol spec declares a
## mismatch a hard error, and continuing with wrong message shapes would
## mis-drive generation rather than fail cleanly.
const CLIENT_PROTOCOL_MAJOR := 1

var state: int = State.DISCONNECTED
var protocol_version: String = ""
var generator_version: String = ""
var last_error: String = ""

var _socket := WebSocketPeer.new()
var _next_id: int = 1
## request id -> method name, so a caller can tell responses apart.
var _inflight: Dictionary = {}


func connect_to_sidecar(url: String) -> void:
	last_error = ""
	_inflight.clear()
	var err := _socket.connect_to_url(url)
	if err != OK:
		state = State.DISCONNECTED
		last_error = "connect_to_url failed: %s" % error_string(err)
		connection_failed.emit(last_error)
		return
	state = State.CONNECTING


func close() -> void:
	_socket.close()
	state = State.DISCONNECTED
	# An explicit close orphans in-flight requests the same way a drop does.
	_fail_inflight("client closed the connection")


func is_connected_to_sidecar() -> bool:
	return state == State.CONNECTED


## Pump the socket. Call every frame.
func poll() -> void:
	_socket.poll()
	var ready := _socket.get_ready_state()

	match ready:
		WebSocketPeer.STATE_OPEN:
			if state != State.CONNECTED:
				state = State.CONNECTED
				sidecar_connected.emit()
			while _socket.get_available_packet_count() > 0:
				_handle_packet(_socket.get_packet().get_string_from_utf8())
		WebSocketPeer.STATE_CLOSED:
			if state != State.DISCONNECTED:
				var was_connecting := state == State.CONNECTING
				state = State.DISCONNECTED
				# Fail every in-flight request BEFORE announcing the disconnect.
				# Without this, a caller awaiting `response` for a request that
				# died with the socket suspends forever — which locked up the
				# dock's poll loop and hung the integration harness.
				_fail_inflight("sidecar disconnected")
				if was_connecting:
					last_error = "could not reach the sidecar"
					connection_failed.emit(last_error)
				else:
					sidecar_disconnected.emit()


## Emit an error response for every request that will never be answered.
func _fail_inflight(reason: String) -> void:
	var ids := _inflight.keys()
	_inflight.clear()
	for id in ids:
		response.emit(int(id), null, {"code": -32001, "message": reason})


func _handle_packet(text: String) -> void:
	var parsed: Variant = JSON.parse_string(text)
	if typeof(parsed) != TYPE_DICTIONARY:
		return
	var msg: Dictionary = parsed

	# Server-pushed events carry no id.
	var event := String(msg.get("event", ""))
	if event == "terrain.hello":
		protocol_version = String(msg.get("protocolVersion", ""))
		generator_version = String(msg.get("generatorVersion", ""))
		var major := int(protocol_version.get_slice(".", 0)) if protocol_version.contains(".") else -1
		if major != CLIENT_PROTOCOL_MAJOR:
			last_error = "protocol mismatch: sidecar %s vs client %d.x" % [
				protocol_version if not protocol_version.is_empty() else "(unknown)",
				CLIENT_PROTOCOL_MAJOR,
			]
			state = State.DISCONNECTED
			_fail_inflight(last_error)
			_socket.close(1002, "protocol mismatch")
			connection_failed.emit(last_error)
		return
	if event == "terrain.progress":
		progress.emit(
			String(msg.get("jobId", "")),
			String(msg.get("stage", "")),
			float(msg.get("progress", 0.0)),
			String(msg.get("detail", ""))
		)
		return

	if not msg.has("id"):
		return
	var id := int(msg.get("id", -1))
	_inflight.erase(id)
	if msg.has("error"):
		response.emit(id, null, msg.get("error", {}))
	else:
		response.emit(id, msg.get("result", null), {})


## Send a request. Returns the request id, or -1 if not connected.
func call_method(method: String, params: Dictionary = {}) -> int:
	if state != State.CONNECTED:
		last_error = "not connected to the sidecar"
		return -1
	var id := _next_id
	_next_id += 1
	_inflight[id] = method
	var payload := {"jsonrpc": "2.0", "id": id, "method": method}
	if not params.is_empty():
		payload["params"] = params
	_socket.send_text(JSON.stringify(payload))
	return id


## Method name a pending request was issued for, or "" if unknown.
func method_for(id: int) -> String:
	return String(_inflight.get(id, ""))


## Human-readable summary of a JSON-RPC error, including the sidecar's own
## structured code when present (spec §28).
static func describe_error(error: Dictionary) -> String:
	if error.is_empty():
		return ""
	var data: Variant = error.get("data", null)
	if typeof(data) == TYPE_DICTIONARY and (data as Dictionary).has("code"):
		var d: Dictionary = data
		return "%s: %s" % [d.get("code", ""), error.get("message", "")]
	return "%s (%s)" % [error.get("message", ""), error.get("code", 0)]
