"""Verify the legacy native pass-through routes during a rolling upgrade."""
import http.server
import json
import os
from pathlib import Path
import secrets
import socket
import subprocess
import tempfile
import threading
import time
import urllib.error
import urllib.request

ROOT = Path(__file__).resolve().parents[2]
MASTER = 'sk-' + secrets.token_hex(24)
MESSAGES = '/v1/messages?beta=true'
COUNT = '/v1/messages/count_tokens?beta=true'
RESPONSES = '/backend-api/codex/responses'


class Provider(http.server.BaseHTTPRequestHandler):
    calls = []
    failure = None

    def log_message(self, *_):
        pass

    def do_POST(self):
        try:
            request = json.loads(self.rfile.read(int(self.headers['Content-Length'])))
            assert self.path in (MESSAGES, COUNT, RESPONSES), 'incorrect upstream path'
            codex = self.path == RESPONSES
            assert self.headers['Authorization'].startswith('Bearer fixture-' + ('codex' if codex else 'claude') + '-access-'), 'wrong OAuth bearer'
            assert not self.headers.get('x-litellm-api-key'), 'proxy master key reached provider'
            assert not self.headers.get('cookie'), 'caller cookie reached provider'
            assert not self.headers.get('x-api-key'), 'caller API key reached provider'
            assert request['model'] == 'fixture-model', 'wrong frozen model'
            if codex:
                assert self.headers['chatgpt-account-id'], 'missing Codex account scope'
            else:
                assert 'oauth-2025-04-20' in self.headers['anthropic-beta'], 'missing OAuth beta'
                assert self.headers['anthropic-version'] == '2023-06-01', 'missing Anthropic version'
                if self.path in (MESSAGES, COUNT):
                    assert request['system'][0]['text'] == "You are Claude Code, Anthropic's official CLI for Claude.", 'missing Claude system prefix'
                    assert request['system'][1]['text'] == 'run safety instructions', 'CLI instructions were lost'
            self.calls.append(self.path)
            if self.path == COUNT:
                payload = b'{"input_tokens":13}'
                media_type = 'application/json'
            else:
                if codex:
                    event = {'type': 'response.completed', 'response': {'id': 'resp-fixture', 'usage': {'input_tokens': 13, 'output_tokens': 2}}}
                else:
                    event = {'type': 'message_delta', 'usage': {'output_tokens': 2}}
                payload = ('data: ' + json.dumps(event) + '\n\n').encode()
                media_type = 'text/event-stream'
            self.send_response(200)
            self.send_header('Content-Type', media_type)
            self.send_header('Content-Length', str(len(payload)))
            self.end_headers()
            self.wfile.write(payload)
        except (AssertionError, KeyError, TypeError) as error:
            Provider.failure = error.args[0]
            self.send_error(400)


def main():
    lite = os.environ.get('MIKKA_NATIVE_LITELLM_BIN', 'litellm')
    server = http.server.ThreadingHTTPServer(('127.0.0.1', 0), Provider)
    threading.Thread(target=server.serve_forever, daemon=True).start()
    vendor = f'http://127.0.0.1:{server.server_port}'
    with socket.socket() as unbound:
        unbound.bind(('127.0.0.1', 0))
        port = unbound.getsockname()[1]
    with tempfile.TemporaryDirectory() as directory:
        config = Path(directory, 'native.yaml')
        source = (ROOT / 'deploy/litellm/config.yaml').read_text()
        # Use the production pass-through fields. Replace only targets at the
        # vendor HTTP boundary and omit unused model/catalogue configuration.
        route_config = source[source.index('    - path: /v1/mikka/subscription/claude/'):source.index('litellm_settings:')]
        for prefix in ('https://api.anthropic.com', 'https://chatgpt.com'):
            route_config = route_config.replace(prefix, vendor)
        config.write_text('general_settings:\n  master_key: os.environ/LITELLM_MASTER_KEY\n  pass_through_endpoints:\n'
                          + route_config + 'litellm_settings:\n  turn_off_message_logging: true\n')
        env = dict(os.environ, LITELLM_MASTER_KEY=MASTER, LITELLM_LOCAL_MODEL_COST_MAP='True')
        base = f'http://127.0.0.1:{port}'
        with open(Path(directory, 'litellm.log'), 'w+') as log:
            proxy = subprocess.Popen([lite, '--config', str(config), '--host', '127.0.0.1', '--port', str(port)], env=env, stdout=log, stderr=log)
            try:
                for _ in range(240):
                    if proxy.poll() is not None:
                        raise RuntimeError('LiteLLM exited before health check')
                    try:
                        with urllib.request.urlopen(base + '/health/liveliness', timeout=1):
                            break
                    except (urllib.error.URLError, TimeoutError):
                        time.sleep(.25)
                else:
                    raise RuntimeError('LiteLLM did not become healthy')
                unauthorized = urllib.request.Request(base + '/v1/mikka/subscription/codex/responses', data=b'{}',
                                                      headers={'Authorization': 'Bearer fixture-codex-access-unauthorized', 'Content-Type': 'application/json'})
                try:
                    with urllib.request.urlopen(unauthorized):
                        raise AssertionError('LiteLLM admitted a request without proxy authorization')
                except urllib.error.HTTPError as error:
                    assert 400 <= error.code < 500
                assert not Provider.calls
                for route, codex, expected in [
                    ('claude/messages', False, b'output_tokens'),
                    ('claude/count_tokens', False, b'input_tokens'),
                    ('codex/responses', True, b'input_tokens'),
                ]:
                    provider = 'codex' if codex else 'claude'
                    payload = {'model': 'fixture-model', 'system': [
                        {'type': 'text', 'text': "You are Claude Code, Anthropic's official CLI for Claude."},
                        {'type': 'text', 'text': 'run safety instructions'},
                    ]}
                    request = urllib.request.Request(base + '/v1/mikka/subscription/' + route,
                        data=json.dumps(payload).encode(), headers={
                            'Authorization': 'Bearer fixture-' + provider + '-access-legacy',
                            'x-litellm-api-key': 'Bearer ' + MASTER,
                            'Content-Type': 'application/json',
                            'chatgpt-account-id': 'fixture-account',
                            'anthropic-beta': 'oauth-2025-04-20',
                            'anthropic-version': '2023-06-01',
                        })
                    with urllib.request.urlopen(request, timeout=10) as response:
                        assert expected in response.read()
                assert Provider.failure is None, Provider.failure
                assert Provider.calls == [MESSAGES, COUNT, RESPONSES], Provider.calls
            finally:
                proxy.terminate()
                proxy.wait(timeout=15)
                server.shutdown()
                server.server_close()
    print('Native subscription transport verified with real LiteLLM and loopback vendor HTTP.')


if __name__ == '__main__':
    main()
