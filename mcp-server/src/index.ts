import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ErrorCode,
  ListToolsRequestSchema,
  McpError,
} from '@modelcontextprotocol/sdk/types.js';
import { WebSocketServer, WebSocket } from 'ws';
import { randomUUID } from 'crypto';

const WS_PORT = parseInt(process.env.MCP_BRIDGE_PORT ?? '3055', 10);

// ─── WebSocket Bridge ─────────────────────────────────────────────────────────

let figmaPlugin: WebSocket | null = null;

const pending = new Map<
  string,
  { resolve: (data: unknown) => void; reject: (err: Error) => void; timer: ReturnType<typeof setTimeout> }
>();

const wss = new WebSocketServer({ port: WS_PORT });

wss.on('listening', () => {
  log(`WebSocket bridge listening on ws://localhost:${WS_PORT}`);
});

wss.on('connection', (ws) => {
  log('Figma plugin connected');
  figmaPlugin = ws;

  ws.on('message', (raw) => {
    try {
      const msg = JSON.parse(raw.toString()) as {
        requestId?: string;
        data?: unknown;
        error?: string;
      };

      if (msg.requestId && pending.has(msg.requestId)) {
        const entry = pending.get(msg.requestId)!;
        clearTimeout(entry.timer);
        pending.delete(msg.requestId);

        if (msg.error) {
          entry.reject(new Error(msg.error));
        } else {
          entry.resolve(msg.data);
        }
      }
    } catch (e) {
      log(`Parse error: ${e}`);
    }
  });

  ws.on('close', () => {
    log('Figma plugin disconnected');
    figmaPlugin = null;
    // Reject all pending requests
    for (const [id, entry] of pending) {
      clearTimeout(entry.timer);
      entry.reject(new Error('Figma plugin disconnected'));
      pending.delete(id);
    }
  });

  ws.on('error', (e) => log(`Plugin WS error: ${e}`));
});

wss.on('error', (e) => log(`WS server error: ${e}`));

function sendToFigma(type: string, payload?: Record<string, unknown>, timeoutMs = 30_000): Promise<unknown> {
  return new Promise((resolve, reject) => {
    if (!figmaPlugin || figmaPlugin.readyState !== WebSocket.OPEN) {
      reject(
        new McpError(
          ErrorCode.InternalError,
          'Figma 플러그인이 연결되어 있지 않습니다. Figma를 열고 MCP Bridge 플러그인을 실행해주세요.'
        )
      );
      return;
    }

    const requestId = randomUUID();
    const timer = setTimeout(() => {
      if (pending.has(requestId)) {
        pending.delete(requestId);
        reject(new McpError(ErrorCode.InternalError, `요청 시간 초과 (${timeoutMs}ms)`));
      }
    }, timeoutMs);

    pending.set(requestId, { resolve, reject, timer });
    figmaPlugin.send(JSON.stringify({ type, payload, requestId }));
  });
}

// ─── MCP Server ───────────────────────────────────────────────────────────────

const server = new Server(
  { name: 'figma-mcp-bridge', version: '1.0.0' },
  { capabilities: { tools: {} } }
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: 'figma_get_selection',
      description:
        '현재 Figma에서 선택된 노드들의 상세 디자인 스펙을 반환합니다. ' +
        '타이포그래피(폰트, 크기, 줄간격), 색상, 레이아웃(flexbox, padding, gap), ' +
        '테두리, 그림자 효과, 자식 노드 포함.',
      inputSchema: {
        type: 'object' as const,
        properties: {
          maxDepth: {
            type: 'number',
            description: '자식 노드 탐색 최대 깊이 (기본값: 5)',
            default: 5,
          },
        },
      },
    },
    {
      name: 'figma_get_node',
      description:
        '특정 노드 ID로 Figma 노드의 전체 디자인 스펙을 가져옵니다. ' +
        'URL의 node-id 파라미터(예: 123:456)를 사용하세요.',
      inputSchema: {
        type: 'object' as const,
        properties: {
          nodeId: {
            type: 'string',
            description: 'Figma 노드 ID (예: "123:456" 또는 "1234:5678")',
          },
          maxDepth: {
            type: 'number',
            description: '자식 노드 탐색 최대 깊이 (기본값: 5)',
            default: 5,
          },
        },
        required: ['nodeId'],
      },
    },
    {
      name: 'figma_get_page_nodes',
      description: '현재 Figma 페이지의 모든 최상위 노드 목록을 가져옵니다.',
      inputSchema: {
        type: 'object' as const,
        properties: {
          maxDepth: {
            type: 'number',
            description: '자식 탐색 깊이 (기본값: 3, 큰 파일은 낮게 설정)',
            default: 3,
          },
        },
      },
    },
    {
      name: 'figma_get_file_info',
      description: '현재 열린 Figma 파일 정보 (파일명, 페이지 목록, 현재 페이지, 선택 개수)를 반환합니다.',
      inputSchema: {
        type: 'object' as const,
        properties: {},
      },
    },
    {
      name: 'figma_get_comments',
      description:
        'Figma 파일의 모든 댓글(코멘트)을 가져옵니다. ' +
        '수정 요청사항, 디자인 피드백, 미해결 이슈를 포함합니다. ' +
        '각 댓글에는 작성자, 내용, 위치, 해결 여부가 포함됩니다. ' +
        'fileKey는 Figma URL에서 추출: https://www.figma.com/design/<fileKey>/...',
      inputSchema: {
        type: 'object' as const,
        properties: {
          fileKey: {
            type: 'string',
            description: 'Figma 파일 키 (URL에서 추출, 예: "serk1hEoUWgx1bvtaR3Lxc"). 미입력 시 현재 열린 파일에서 자동 감지 시도.',
          },
          unresolvedOnly: {
            type: 'boolean',
            description: 'true이면 미해결 댓글만 반환 (기본값: false)',
            default: false,
          },
        },
      },
    },
    {
      name: 'figma_export_node',
      description: 'Figma 노드를 PNG/SVG/JPG 이미지로 내보냅니다 (base64 반환). 실제 디자인과 구현 비교에 활용.',
      inputSchema: {
        type: 'object' as const,
        properties: {
          nodeId: {
            type: 'string',
            description: 'Figma 노드 ID',
          },
          format: {
            type: 'string',
            enum: ['PNG', 'SVG', 'JPG'],
            description: '내보내기 포맷 (기본값: PNG)',
            default: 'PNG',
          },
          scale: {
            type: 'number',
            description: '배율 (기본값: 2 = @2x)',
            default: 2,
          },
        },
        required: ['nodeId'],
      },
    },
    {
      name: 'figma_reply_comment',
      description:
        'Figma 댓글에 답글을 답니다. ' +
        '수정 사항을 답글로 남깁니다. 해결 완료(resolve) 처리는 Figma 공개 API 미지원으로 UI에서 직접 해주세요. ' +
        'fileKey는 Figma URL에서 추출: https://www.figma.com/design/<fileKey>/...',
      inputSchema: {
        type: 'object' as const,
        properties: {
          fileKey: {
            type: 'string',
            description: 'Figma 파일 키 (URL에서 추출)',
          },
          commentId: {
            type: 'string',
            description: '답글을 달 댓글 ID',
          },
          message: {
            type: 'string',
            description: '답글 내용 (수정 완료 내역 등)',
          },
        },
        required: ['fileKey', 'commentId', 'message'],
      },
    },
    {
      name: 'figma_get_styles',
      description:
        'Figma 파일에 정의된 로컬 디자인 시스템 스타일을 모두 가져옵니다. ' +
        '색상 팔레트, 텍스트 스타일, 이펙트 스타일 포함.',
      inputSchema: {
        type: 'object' as const,
        properties: {},
      },
    },
  ],
}));

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args = {} } = request.params;

  try {
    switch (name) {
      case 'figma_get_selection': {
        const data = await sendToFigma('get_selection', { maxDepth: args.maxDepth ?? 5 });
        return { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] };
      }

      case 'figma_get_node': {
        if (!args.nodeId) throw new McpError(ErrorCode.InvalidParams, 'nodeId가 필요합니다');
        const data = await sendToFigma('get_node', {
          nodeId: args.nodeId as string,
          maxDepth: args.maxDepth ?? 5,
        });
        return { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] };
      }

      case 'figma_get_page_nodes': {
        const data = await sendToFigma('get_page_nodes', { maxDepth: args.maxDepth ?? 3 });
        return { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] };
      }

      case 'figma_get_file_info': {
        const data = await sendToFigma('get_file_info');
        return { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] };
      }

      case 'figma_get_comments': {
        const apiToken = process.env.FIGMA_API_TOKEN;
        if (!apiToken) {
          throw new McpError(ErrorCode.InternalError, 'FIGMA_API_TOKEN 환경변수가 설정되지 않았습니다. MCP 서버 설정에 env.FIGMA_API_TOKEN을 추가해주세요.');
        }

        // Use provided fileKey, or try to get it from the plugin
        let resolvedFileKey = args.fileKey as string | undefined;
        if (!resolvedFileKey) {
          const fileInfo = await sendToFigma('get_file_info') as { fileKey?: string };
          resolvedFileKey = fileInfo.fileKey;
        }
        if (!resolvedFileKey) {
          throw new McpError(
            ErrorCode.InternalError,
            'Figma 파일 키를 가져올 수 없습니다. fileKey 파라미터에 Figma URL의 파일 키를 직접 전달해주세요.\n' +
            '예: https://www.figma.com/design/<fileKey>/... 에서 <fileKey> 부분'
          );
        }
        const fileKey = resolvedFileKey;

        // Fetch comments via Figma REST API
        const res = await fetch(`https://api.figma.com/v1/files/${fileKey}/comments`, {
          headers: { 'X-Figma-Token': apiToken },
        });
        if (!res.ok) {
          throw new McpError(ErrorCode.InternalError, `Figma API 오류: ${res.status} ${res.statusText}`);
        }

        type FigmaComment = {
          id: string; message: string; created_at: string; resolved_at: string | null;
          user: { handle: string; id: string };
          client_meta: Record<string, unknown>;
          reactions: unknown[];
        };
        const data = await res.json() as { comments: FigmaComment[] };

        let comments = data.comments.map((c) => ({
          id: c.id,
          message: c.message,
          author: c.user?.handle ?? 'Unknown',
          createdAt: c.created_at,
          resolved: c.resolved_at !== null,
          resolvedAt: c.resolved_at,
          position: c.client_meta,
          reactions: c.reactions ?? [],
        }));

        if (args.unresolvedOnly) {
          comments = comments.filter((c) => !c.resolved);
        }
        return { content: [{ type: 'text', text: JSON.stringify({ count: comments.length, comments }, null, 2) }] };
      }

      case 'figma_export_node': {
        if (!args.nodeId) throw new McpError(ErrorCode.InvalidParams, 'nodeId가 필요합니다');
        const data = (await sendToFigma(
          'export_node',
          {
            nodeId: args.nodeId as string,
            format: args.format ?? 'PNG',
            scale: args.scale ?? 2,
          },
          60_000 // 60s timeout for exports
        )) as { base64: string; format: string };

        const mimeMap: Record<string, string> = {
          PNG: 'image/png',
          JPG: 'image/jpeg',
          SVG: 'image/svg+xml',
        };

        return {
          content: [
            {
              type: 'image',
              data: data.base64,
              mimeType: mimeMap[data.format] ?? 'image/png',
            },
          ],
        };
      }

      case 'figma_reply_comment': {
        const apiToken = process.env.FIGMA_API_TOKEN;
        if (!apiToken) {
          throw new McpError(ErrorCode.InternalError, 'FIGMA_API_TOKEN 환경변수가 설정되지 않았습니다.');
        }
        if (!args.fileKey) throw new McpError(ErrorCode.InvalidParams, 'fileKey가 필요합니다');
        if (!args.commentId) throw new McpError(ErrorCode.InvalidParams, 'commentId가 필요합니다');
        if (!args.message) throw new McpError(ErrorCode.InvalidParams, 'message가 필요합니다');

        const headers = { 'X-Figma-Token': apiToken, 'Content-Type': 'application/json' };

        // 1. 답글 달기
        const replyRes = await fetch(`https://api.figma.com/v1/files/${args.fileKey}/comments`, {
          method: 'POST',
          headers,
          body: JSON.stringify({ message: `[AI 자동수정] ${args.message}`, comment_id: args.commentId }),
        });
        if (!replyRes.ok) {
          const text = await replyRes.text();
          throw new McpError(ErrorCode.InternalError, `답글 실패: ${replyRes.status} ${text}`);
        }
        const replyData = await replyRes.json() as { id: string };

        // Note: Figma 공개 REST API에는 타인 댓글을 resolve하는 엔드포인트가 없습니다.
        // 해결 완료 처리는 Figma UI에서 직접 해주세요.

        return {
          content: [{
            type: 'text',
            text: JSON.stringify({
              success: true,
              replyId: replyData.id,
              message: '답글을 달았습니다. 해결 완료 처리는 Figma UI에서 직접 해주세요.',
            }, null, 2),
          }],
        };
      }

      case 'figma_get_styles': {
        const data = await sendToFigma('get_styles');
        return { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] };
      }

      default:
        throw new McpError(ErrorCode.MethodNotFound, `알 수 없는 도구: ${name}`);
    }
  } catch (e) {
    if (e instanceof McpError) throw e;
    throw new McpError(ErrorCode.InternalError, String(e));
  }
});

// ─── Start ────────────────────────────────────────────────────────────────────

function log(msg: string) {
  // stderr so it doesn't interfere with MCP stdio protocol
  process.stderr.write(`[figma-mcp] ${msg}\n`);
}

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  log('MCP 서버 시작됨 (stdio)');
}

main().catch((e) => {
  log(`Fatal: ${e}`);
  process.exit(1);
});
