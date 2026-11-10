'use strict';
module.exports = function createRpcHandler(TOOLS, executeTool) {
async function handleJsonRpc(msg) {
  if (!msg || typeof msg !== 'object') return null;
  const { id, method, params } = msg;

  try {
    if (method === 'initialize') {
      return {
        jsonrpc: '2.0',
        id,
        result: {
          protocolVersion: (params && params.protocolVersion) || '2024-11-05',
          capabilities: {
            tools: { listChanged: false },
          },
          serverInfo: {
            name: 'mac-industrial-mcp',
            version: '2.1.0',
          },
        },
      };
    }

    if (method === 'notifications/initialized' || method === 'initialized') {
      return null;
    }

    if (method === 'ping') {
      return { jsonrpc: '2.0', id, result: {} };
    }

    if (method === 'tools/list') {
      return {
        jsonrpc: '2.0',
        id,
        result: { tools: TOOLS },
      };
    }

    if (method === 'tools/call') {
      const toolName = params?.name;
      const toolArgs = params?.arguments || {};
      try {
        const output = await executeTool(toolName, toolArgs);
        const content = output && typeof output === 'object' && Array.isArray(output.__mcp_content)
          ? output.__mcp_content
          : [{ type: 'text', text: String(output) }];
        return {
          jsonrpc: '2.0',
          id,
          result: {
            content,
            isError: false,
          },
        };
      } catch (err) {
        return {
          jsonrpc: '2.0',
          id,
          result: {
            content: [{ type: 'text', text: `Tool Error (${toolName}): ${err.message}` }],
            isError: true,
          },
        };
      }
    }

    if (id !== undefined) {
      return {
        jsonrpc: '2.0',
        id,
        error: { code: -32601, message: `Method not found: ${method}` },
      };
    }
    return null;
  } catch (err) {
    if (id !== undefined) {
      return {
        jsonrpc: '2.0',
        id,
        error: { code: -32603, message: err.message },
      };
    }
    return null;
  }
}


return handleJsonRpc;
};
