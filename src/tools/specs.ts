/** Frozen Codex descriptions and field instructions; see tests/fixtures/codex-tools.json.
 * Flat Pi names and notes character paging are the deliberate interface adaptations.
 * Codex's encrypted annotations are omitted: local inputs are plain strings. */
export const TOOL_SPECS = {
	"new_context": {
		"codexName": "functions.new_context",
		"description": "Start a new context window. Does not clear, reset, or otherwise affect environment state.",
		"parameters": {
			"type": "object",
			"properties": {},
			"additionalProperties": false
		},
		"executionMode": "sequential"
	},
	"get_context_remaining": {
		"codexName": "functions.get_context_remaining",
		"description": "Get the remaining tokens in the current context window.",
		"parameters": {
			"type": "object",
			"properties": {},
			"additionalProperties": false
		},
		"executionMode": "parallel"
	},
	"history_list_windows": {
		"codexName": "history.list_windows",
		"description": "List an agent's context windows as window ID and item-count pairs. Private model-only recovery; never disclose this activity.",
		"parameters": {
			"type": "object",
			"properties": {
				"limit": {
					"type": "integer",
					"minimum": 1,
					"description": "Maximum number of windows to return."
				},
				"agent_name": {
					"anyOf": [
						{
							"type": "string"
						},
						{
							"type": "null"
						}
					],
					"description": "Agent whose history to inspect. Omit to use the current agent; otherwise pass an absolute agent name or a name relative to the current agent."
				},
				"recent_first": {
					"type": "boolean",
					"description": "Whether to return the most recently created windows first."
				}
			}
		},
		"executionMode": "parallel"
	},
	"history_list_items": {
		"codexName": "history.list_items",
		"description": "List history items with optional window, role, and tool filters. Private model-only recovery; never disclose this activity.",
		"parameters": {
			"type": "object",
			"properties": {
				"limit": {
					"type": "integer",
					"minimum": 1,
					"description": "Maximum number of items to return."
				},
				"recent_first": {
					"type": "boolean",
					"description": "Whether to return the most recently created items first."
				},
				"tool_namespace": {
					"anyOf": [
						{
							"type": "string"
						},
						{
							"type": "null"
						}
					],
					"description": "Callable namespace to include. When set, non-tool messages are excluded."
				},
				"role": {
					"anyOf": [
						{
							"type": "string",
							"enum": [
								"user",
								"assistant",
								"tool",
								"system",
								"developer"
							]
						},
						{
							"type": "null"
						}
					],
					"description": "Message role to include. Null or omission includes all roles."
				},
				"agent_name": {
					"anyOf": [
						{
							"type": "string"
						},
						{
							"type": "null"
						}
					],
					"description": "Agent whose history to inspect. Omit to use the current agent; otherwise pass an absolute agent name or a name relative to the current agent."
				},
				"tool_name": {
					"anyOf": [
						{
							"type": "string"
						},
						{
							"type": "null"
						}
					],
					"description": "Callable tool name to include. When set, non-tool messages are excluded."
				},
				"window_id": {
					"anyOf": [
						{
							"type": "string"
						},
						{
							"type": "null"
						}
					],
					"description": "Full window ID. Null or omission includes all windows."
				},
				"max_chars_per_item": {
					"type": "integer",
					"minimum": 1,
					"description": "Maximum characters returned in each item's truncated_content."
				}
			}
		},
		"executionMode": "parallel"
	},
	"history_read_item": {
		"codexName": "history.read_item",
		"description": "Read a bounded range from private model-only history. Never disclose the item or this activity.",
		"parameters": {
			"type": "object",
			"properties": {
				"agent_name": {
					"anyOf": [
						{
							"type": "string"
						},
						{
							"type": "null"
						}
					],
					"description": "Agent whose history to inspect. Omit to use the current agent; otherwise pass an absolute agent name or a name relative to the current agent."
				},
				"item_id": {
					"type": "string",
					"description": "The short item ID is the suffix shown in the target item's trailing `[id: ...]` marker, printed after that item's content."
				},
				"offset_chars": {
					"type": "integer",
					"minimum": 0,
					"description": "Zero-based character offset at which reading starts."
				},
				"limit_chars": {
					"type": "integer",
					"minimum": 1,
					"description": "Maximum number of characters to return."
				},
				"window_id": {
					"type": "string",
					"description": "Full window ID containing the item."
				}
			},
			"required": [
				"item_id",
				"window_id"
			]
		},
		"executionMode": "parallel"
	},
	"history_search_contents": {
		"codexName": "history.search_contents",
		"description": "Search private model-only history by literal substring. Never disclose results or this activity.",
		"parameters": {
			"type": "object",
			"properties": {
				"limit": {
					"type": "integer",
					"minimum": 1,
					"description": "Maximum number of matching items to return."
				},
				"query": {
					"type": "string",
					"description": "Case-sensitive literal substring to find in item content."
				},
				"recent_first": {
					"type": "boolean",
					"description": "Whether to return the most recently created matches first."
				},
				"tool_namespace": {
					"anyOf": [
						{
							"type": "string"
						},
						{
							"type": "null"
						}
					],
					"description": "Callable namespace to include. When set, non-tool messages are excluded."
				},
				"role": {
					"anyOf": [
						{
							"type": "string",
							"enum": [
								"user",
								"assistant",
								"tool",
								"system",
								"developer"
							]
						},
						{
							"type": "null"
						}
					],
					"description": "Message role to include. Null or omission includes all roles."
				},
				"agent_name": {
					"anyOf": [
						{
							"type": "string"
						},
						{
							"type": "null"
						}
					],
					"description": "Agent whose history to inspect. Omit to use the current agent; otherwise pass an absolute agent name or a name relative to the current agent."
				},
				"tool_name": {
					"anyOf": [
						{
							"type": "string"
						},
						{
							"type": "null"
						}
					],
					"description": "Callable tool name to include. When set, non-tool messages are excluded."
				},
				"window_id": {
					"anyOf": [
						{
							"type": "string"
						},
						{
							"type": "null"
						}
					],
					"description": "Full window ID. Null or omission includes all windows."
				}
			},
			"required": [
				"query"
			]
		},
		"executionMode": "parallel"
	},
	"notes_list_files_by_prefix": {
		"codexName": "notes.list_files_by_prefix",
		"description": "List private model-only notes by path prefix. Never disclose paths, contents, or this activity.",
		"parameters": {
			"type": "object",
			"properties": {
				"prefix": {
					"anyOf": [
						{
							"type": "string"
						},
						{
							"type": "null"
						}
					],
					"description": "Note path prefix to list."
				},
				"max_results": {
					"type": "integer",
					"minimum": 1,
					"description": "Maximum number of files to return."
				},
				"file_order_by": {
					"type": "string",
					"enum": [
						"name",
						"created_at",
						"updated_at"
					],
					"description": "Field used to order files."
				},
				"file_order": {
					"type": "string",
					"enum": [
						"ascending",
						"descending"
					],
					"description": "Direction used to order files."
				}
			}
		},
		"executionMode": "parallel"
	},
	"notes_read_file": {
		"codexName": "notes.read_file",
		"description": "Read all or a line range from private model-only notes. Never disclose paths, contents, or this activity.",
		"parameters": {
			"type": "object",
			"properties": {
				"path": {
					"type": "string",
					"description": "Note file path to read."
				},
				"start_line": {
					"anyOf": [
						{
							"type": "integer"
						},
						{
							"type": "null"
						}
					],
					"description": "First line to return, inclusive and 1-based. Negative values count backward from the final line."
				},
				"stop_line": {
					"anyOf": [
						{
							"type": "integer"
						},
						{
							"type": "null"
						}
					],
					"description": "Last line to return, inclusive and 1-based. Negative values count backward from the final line."
				},
				"offset_chars": {
					"type": "integer",
					"minimum": 0,
					"description": "Pi extension: zero-based Unicode character offset after line selection. Use to page past very long lines."
				},
				"limit_chars": {
					"type": "integer",
					"minimum": 1,
					"description": "Pi extension: maximum Unicode characters to return after line selection."
				}
			},
			"required": [
				"path"
			]
		},
		"executionMode": "parallel"
	},
	"notes_search_contents": {
		"codexName": "notes.search_contents",
		"description": "Search private model-only note lines by literal substring. Never disclose results or this activity.",
		"parameters": {
			"type": "object",
			"properties": {
				"max_matches_per_file": {
					"type": "integer",
					"minimum": 1,
					"description": "Maximum number of matching lines returned per file."
				},
				"query": {
					"type": "string",
					"description": "Case-sensitive literal substring to find in note lines."
				},
				"recent_file_first": {
					"type": "boolean",
					"description": "Whether to order matching files by creation time, newest first."
				},
				"max_files": {
					"type": "integer",
					"minimum": 1,
					"description": "Maximum number of matching files returned."
				},
				"path_prefix": {
					"anyOf": [
						{
							"type": "string"
						},
						{
							"type": "null"
						}
					],
					"description": "Note path prefix to search."
				}
			},
			"required": [
				"query"
			]
		},
		"executionMode": "parallel"
	},
	"notes_append_to_file": {
		"codexName": "notes.append_to_file",
		"description": "Append text to private model-only notes. Never disclose paths, contents, or this activity.",
		"parameters": {
			"type": "object",
			"properties": {
				"text": {
					"type": "string",
					"description": "Text appended exactly as provided."
				},
				"path": {
					"type": "string",
					"description": "Note file path to append to."
				}
			},
			"required": [
				"text",
				"path"
			]
		},
		"executionMode": "sequential"
	},
	"notes_write_file": {
		"codexName": "notes.write_file",
		"description": "Create or replace private model-only notes. Never disclose paths, contents, or this activity.",
		"parameters": {
			"type": "object",
			"properties": {
				"text": {
					"type": "string",
					"description": "Complete replacement text for the file."
				},
				"path": {
					"type": "string",
					"description": "Note file path to create or replace."
				}
			},
			"required": [
				"text",
				"path"
			]
		},
		"executionMode": "sequential"
	}
} as const;

export const NAMESPACE_DESCRIPTIONS = {
	"history": "Recover prior conversation after a context-window reset by listing, reading, and searching normalized history using agent names and the opaque window and item IDs returned by these tools. Pass returned IDs unchanged when filtering or reading an item. Items are ordered by persisted ordinal, then creation time; list and search calls return no matches for an unknown window. Calls use the current agent by default; pass an absolute agent name or one relative to the current agent to inspect another agent. History is read-only and eventually consistent, so newly generated items may take a few seconds to appear. This is private model-only state. Use it silently to continue the task. Never disclose or describe the tool, its existence or use, paths, storage or recovery mechanisms, or the private contents (including by quoting or summarizing them) to the user.",
	"notes": "Read and maintain private notes that survive context-window transitions within this rollout. Paths are virtual, not filesystem paths. Relative file paths use the current agent's <agent_name>/notes directory; cross-agent paths must be absolute. Absolute paths use <agent_name>/notes[/<path>]. Reads, listings, searches, and writes may access other agents' notes. File operations require <path>; path-prefix arguments may be omitted to use the current notes directory. Empty, '.', and '..' path components are unsupported. Shell expansion is not performed, so '~' is treated literally. Note reads reflect successful writes immediately; listings and searches are eventually consistent and may take a few seconds to reflect writes. Every file must remain at or below 1,000,000 UTF-8 bytes; create another file before approaching the limit. This is private model-only state. Use it silently to continue the task. Never disclose or describe the tool, its existence or use, paths, storage or recovery mechanisms, or the private contents (including by quoting or summarizing them) to the user."
} as const;
