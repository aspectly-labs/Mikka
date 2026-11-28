"""Fixtures for conversion and provider-managed tools through LiteLLM.

Used with tests/model-gateway-litellm.test.ts against the real LiteLLM image:
offered tools, it streams one `bash` tool call (usage 20 in / 5 out); otherwise
it streams a short reply (usage 11 in / 2 out). Native search has separate
credentials and request validation under Responses, Messages and Gateway TypeSafe.
"""
import json
import sys
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import urlsplit

HAIKU = 'anthropic/claude-haiku-5.5'
HAIKU_STREAM_ID = 'gen_01ARZ3NDEKTSV4RRFFQ69G5FAV'
HAIKU_GENERATE_ID = 'gen_01ARZ3NDEKTSV4RRFFQ69G5FAW'

MODEL_KEYS = {
    'zai/glm-5': 'sk-person-key',
    'fixture/provider-model': 'sk-vercel-fixture',
    'openai/gpt-6-luna': 'sk-vercel-fixture',
    'gpt-5-mini': 'sk-neon-fixture',
}


def chunk(delta, finish=None, usage=None):
    body = {'id': 'chatcmpl-mock', 'object': 'chat.completion.chunk', 'created': 0, 'model': 'mock',
            'choices': [{'index': 0, 'delta': delta, 'finish_reason': finish}]}
    if usage:
        body['usage'] = usage
    return 'data: ' + json.dumps(body) + '\n\n'


class Provider(BaseHTTPRequestHandler):
    def log_message(self, *_):
        pass

    def do_POST(self):
        if self.path == '/v4/ai/language-model':
            self.gateway_search()
            return
        if self.path.rstrip('/') in ('/v1/responses', '/responses'):
            self.native_search()
            return
        if self.path.rstrip('/') == '/v1/messages':
            self.anthropic_search()
            return
        if self.path.rstrip('/') not in ('/v1/chat/completions', '/chat/completions'):
            self.send_error(404)
            return
        request = json.loads(self.rfile.read(int(self.headers.get('content-length', 0))) or b'{}')
        model = request.get('model')
        if model not in MODEL_KEYS:
            self.send_error(400, 'model routing changed the provider/model slug')
            return
        if self.headers.get('authorization') != 'Bearer ' + MODEL_KEYS[model]:
            self.send_error(401)
            return
        tool = bool(request.get('tools'))
        usage = ({'prompt_tokens': 20, 'completion_tokens': 5, 'total_tokens': 25} if tool
                 else {'prompt_tokens': 11, 'completion_tokens': 2, 'total_tokens': 13})
        if tool:
            parts = [chunk({'role': 'assistant', 'tool_calls': [{'index': 0, 'id': 'call_mock', 'type': 'function',
                                                                'function': {'name': 'bash', 'arguments': ''}}]}),
                     chunk({'tool_calls': [{'index': 0, 'function': {'arguments': '{"c": "ls"}'}}]}),
                     chunk({}, 'tool_calls')]
            message = {'role': 'assistant', 'content': None, 'tool_calls': [{'id': 'call_mock', 'type': 'function',
                       'function': {'name': 'bash', 'arguments': '{"c": "ls"}'}}]}
            finish = 'tool_calls'
        else:
            parts = [chunk({'role': 'assistant', 'content': 'Hello'}), chunk({'content': '.'}), chunk({}, 'stop')]
            message, finish = {'role': 'assistant', 'content': 'Hello.'}, 'stop'
        if not request.get('stream'):
            body = json.dumps({'id': 'chatcmpl-mock', 'object': 'chat.completion', 'created': 0, 'model': model,
                               'choices': [{'index': 0, 'message': message, 'finish_reason': finish}], 'usage': usage}).encode()
            self.send_response(200)
            self.send_header('content-type', 'application/json')
            self.send_header('content-length', str(len(body)))
            self.end_headers()
            self.wfile.write(body)
            return
        self.send_response(200)
        self.send_header('content-type', 'text/event-stream')
        self.end_headers()
        usage_chunk = 'data: ' + json.dumps({'id': 'chatcmpl-mock', 'object': 'chat.completion.chunk', 'created': 0,
                                             'model': 'mock', 'choices': [], 'usage': usage}) + '\n\n'
        for part in [*parts, usage_chunk, 'data: [DONE]\n\n']:
            self.wfile.write(part.encode())
            self.wfile.flush()

    def native_search(self):
        request = json.loads(self.rfile.read(int(self.headers.get('content-length', 0))) or b'{}')
        key = self.headers.get('authorization')
        model = 'openai/gpt-6-luna' if key == 'Bearer sk-vercel-fixture' else 'gpt-5.5'
        if key not in ('Bearer sk-person-search-fixture', 'Bearer sk-vercel-fixture'):
            self.send_error(401)
            return
        tools = request.get('tools', [])
        stream = request.get('stream') is True
        tool_types = [tool.get('type') for tool in tools]
        stream_shape = stream and tool_types == ['web_search', 'function'] and tools[1].get('name') == 'lookup'
        fallback_shape = (not stream and model == 'openai/gpt-6-luna' and tool_types == ['web_search']
                          and request.get('tool_choice') == 'required' and tools[0].get('search_context_size') == 'low')
        if (request.get('model') != model or not (stream_shape or fallback_shape)
                or request.get('store') is not False
                or 'web_search_call.action.sources' not in request.get('include', [])):
            self.send_error(400, 'native search request changed')
            return
        url = 'https://example.com/source'
        search = {'type': 'web_search_call', 'id': 'search-fixture', 'status': 'completed',
                  'action': {'type': 'search', 'query': 'fixture', 'sources': [{'type': 'url', 'url': url}]}}
        annotation = {'type': 'url_citation', 'url': url, 'title': 'Public source', 'start_index': 0, 'end_index': 7}
        message = {'type': 'message', 'id': 'message-fixture', 'role': 'assistant', 'status': 'completed',
                   'content': [{'type': 'output_text', 'text': 'fixture', 'annotations': [annotation]}]}
        response = {'id': 'resp-search-fixture', 'object': 'response', 'status': 'completed', 'created_at': 1,
                    'model': model, 'output': [search, message],
                    'usage': {'input_tokens': 5, 'output_tokens': 2, 'total_tokens': 7}}
        if model == 'openai/gpt-6-luna':
            response['usage']['cost'] = 0.037981
        if not stream:
            body = json.dumps(response).encode()
            self.send_response(200)
            self.send_header('content-type', 'application/json')
            self.send_header('content-length', str(len(body)))
            self.end_headers()
            self.wfile.write(body)
            return
        events = [
            {'type': 'response.created', 'response': {**response, 'status': 'in_progress', 'output': [], 'usage': None}},
            {'type': 'response.output_item.added', 'output_index': 0, 'item': {**search, 'status': 'in_progress'}},
            {'type': 'response.output_item.done', 'output_index': 0, 'item': search},
            {'type': 'response.output_item.added', 'output_index': 1, 'item': {'type': 'message', 'id': message['id']}},
            {'type': 'response.output_text.delta', 'output_index': 1, 'item_id': message['id'], 'delta': 'fixture'},
            {'type': 'response.output_text.annotation.added', 'output_index': 1, 'item_id': message['id'], 'annotation': annotation},
            {'type': 'response.output_item.done', 'output_index': 1, 'item': message},
            {'type': 'response.completed', 'response': response},
        ]
        self.send_response(200)
        self.send_header('content-type', 'text/event-stream')
        self.end_headers()
        for index, event in enumerate(events):
            event['sequence_number'] = index
            self.wfile.write(('data: ' + json.dumps(event) + '\n\n').encode())
            self.wfile.flush()

    def anthropic_search(self):
        request = json.loads(self.rfile.read(int(self.headers.get('content-length', 0))))
        key = self.headers.get('x-api-key')
        if key != 'sk-person-messages-fixture':
            self.send_error(401)
            return
        tools = request.get('tools', [])
        content = request.get('messages', [{}])[0].get('content', [])
        if (request.get('model') != 'claude-haiku-5-5' or not request.get('stream')
                or [tool.get('name') for tool in tools] != ['web_search', 'lookup']
                or tools[0].get('type') != 'web_search_20250305' or not tools[1].get('input_schema')
                or not any(block.get('type') == 'image' for block in content)):
            self.send_error(400, 'native Messages request changed')
            return
        url = 'https://example.com/source'
        search = {'type': 'server_tool_use', 'id': 'srvtoolu_search', 'name': 'web_search', 'input': {}}
        result = {'type': 'web_search_tool_result', 'tool_use_id': search['id'], 'content': [
            {'type': 'web_search_result', 'title': 'Public source', 'url': url, 'encrypted_content': 'fixture'}]}
        citation = {'type': 'web_search_result_location', 'url': url, 'title': 'Public source',
                    'cited_text': 'fixture', 'encrypted_index': 'fixture'}
        events = [
            {'type': 'message_start', 'message': {'id': 'msg_search_fixture', 'type': 'message', 'model': request['model'],
             'role': 'assistant', 'content': [], 'stop_reason': None, 'usage': {'input_tokens': 5, 'output_tokens': 0}}},
            {'type': 'content_block_start', 'index': 0, 'content_block': search},
            {'type': 'content_block_delta', 'index': 0, 'delta': {'type': 'input_json_delta', 'partial_json': '{"query":"fixture"}'}},
            {'type': 'content_block_stop', 'index': 0},
            {'type': 'content_block_start', 'index': 1, 'content_block': result},
            {'type': 'content_block_stop', 'index': 1},
            {'type': 'content_block_start', 'index': 2, 'content_block': {'type': 'text', 'text': ''}},
            {'type': 'content_block_delta', 'index': 2, 'delta': {'type': 'text_delta', 'text': 'fixture'}},
            {'type': 'content_block_delta', 'index': 2, 'delta': {'type': 'citations_delta', 'citation': citation}},
            {'type': 'content_block_stop', 'index': 2},
            {'type': 'message_delta', 'delta': {'stop_reason': 'end_turn'}, 'usage': {
                'output_tokens': 2, 'server_tool_use': {'web_search_requests': 1}}},
            {'type': 'message_stop'},
        ]
        self.send_response(200)
        self.send_header('content-type', 'text/event-stream')
        self.end_headers()
        for event in events:
            self.wfile.write(('event: ' + event['type'] + '\ndata: ' + json.dumps(event) + '\n\n').encode())
            self.wfile.flush()

    def write_json(self, payload):
        body = json.dumps(payload).encode()
        self.send_response(200)
        self.send_header('content-type', 'application/json')
        self.send_header('content-length', str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def gateway_search(self):
        request = json.loads(self.rfile.read(int(self.headers.get('content-length', 0))))
        streaming = self.headers.get('ai-language-model-streaming')
        if (self.headers.get('authorization') != 'Bearer sk-vercel-fixture'
                or self.headers.get('ai-gateway-auth-method') != 'api-key'
                or self.headers.get('ai-gateway-protocol-version') != '0.0.1'
                or self.headers.get('ai-language-model-specification-version') != '4'
                or self.headers.get('ai-language-model-id') != HAIKU
                or self.headers.get('x-litellm-call-id') is not None
                or streaming not in ('true', 'false')):
            self.send_error(400, 'unexpected Gateway TypeSafe headers')
            return
        tools = request.get('tools', [])
        content = request.get('prompt', [{}])[0].get('content', [])
        if ('stream' in request or 'custom_body' in request or 'providerOptions' in request
                or [tool.get('type') for tool in tools] != ['provider', 'function']
                or tools[0].get('id') != 'anthropic.web_search_20250305' or tools[1].get('name') != 'lookup'
                or not any(part.get('mediaType') == 'image/png' for part in content)):
            self.send_error(400, 'unexpected Gateway TypeSafe request')
            return
        mode = streaming == 'true'
        metadata = {'gateway': {'generationId': HAIKU_STREAM_ID if mode else HAIKU_GENERATE_ID}}
        usage = {'inputTokens': {'total': 5}, 'outputTokens': {'total': 2}}
        reason = {'unified': 'stop', 'raw': 'end_turn'}
        call = {'type': 'tool-call', 'toolCallId': 'search-id', 'toolName': 'web_search', 'input': '{}', 'providerExecuted': True}
        result = {'type': 'tool-result', 'toolCallId': 'search-id', 'toolName': 'web_search', 'result': {'query': 'fixture'}}
        source = {'type': 'source', 'sourceType': 'url', 'id': 'source-id', 'url': 'https://example.com/source'}
        if not mode:
            self.write_json({'content': [call, result, source], 'providerMetadata': metadata, 'finishReason': reason, 'usage': usage})
            return
        self.send_response(200)
        self.send_header('content-type', 'text/event-stream')
        self.send_header('x-litellm-call-id', 'provisional-id')
        self.end_headers()
        events = [{**call, 'providerMetadata': metadata}, result, source,
                  {'type': 'finish', 'finishReason': reason, 'usage': usage}]
        for event in events:
            self.wfile.write(('data: ' + json.dumps(event) + '\n\n').encode())
            self.wfile.flush()

    def do_GET(self):
        url = urlsplit(self.path)
        generation = url.query.removeprefix('id=')
        if (url.path != '/v1/generation' or not url.query.startswith('id=')
                or generation not in (HAIKU_STREAM_ID, HAIKU_GENERATE_ID)):
            self.send_error(404)
            return
        if self.headers.get('authorization') != 'Bearer sk-vercel-fixture':
            self.send_error(401)
            return
        self.write_json({'data': {'id': generation, 'model': HAIKU, 'is_byok': False,
                                 'total_cost': 0.037981, 'gateway_cost': 0.037981, 'billable_web_search_calls': 1}})


if __name__ == '__main__':
    ThreadingHTTPServer(('0.0.0.0', int(sys.argv[1]) if len(sys.argv) > 1 else 9911), Provider).serve_forever()
