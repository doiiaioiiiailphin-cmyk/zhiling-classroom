import asyncio
from collections.abc import Mapping
from urllib.parse import parse_qsl, urlencode, urlsplit, urlunsplit

import httpx

from ..errors import AppError


class UpstreamRejected(AppError):
    def __init__(self, status: int, detail: str = ""):
        self.upstream_status = status
        if status in (401, 403):
            super().__init__(401, "PROVIDER_AUTH_FAILED", "供应商认证失败，请检查密钥和服务权限")
        elif status == 429:
            super().__init__(502, "PROVIDER_RATE_LIMITED", "供应商已限流，请稍后重试")
        else:
            suffix = f"：{detail}" if detail else ""
            super().__init__(502, "PROVIDER_REQUEST_FAILED", f"供应商请求失败（HTTP {status}）{suffix}")


def extract_error_detail(response: httpx.Response, headers: Mapping[str, str] | None = None) -> str:
    try:
        payload = response.json()
    except ValueError:
        return ""
    detail = ""
    if isinstance(payload, dict):
        err = payload.get("error")
        if isinstance(err, dict) and isinstance(err.get("message"), str):
            detail = err["message"].strip()
        elif isinstance(err, str):
            detail = err.strip()
        elif isinstance(payload.get("message"), str):
            detail = payload["message"].strip()
    if detail and headers:
        secret_headers = {"authorization", "x-api-key", "x-goog-api-key", "xi-api-key"}
        for name, header_val in headers.items():
            if name.lower() in secret_headers and isinstance(header_val, str) and header_val.strip():
                raw = header_val.strip()
                token = raw.split(" ", 1)[1].strip() if " " in raw else raw
                if len(token) >= 4:
                    detail = detail.replace(token, "***")
    return " ".join(detail.split())[:220]


def endpoint(value: str, schemes: set[str]) -> str:
    value = value.strip()
    if not value or any(char.isspace() or char == "\\" or ord(char) < 32 for char in value):
        raise AppError(400, "INVALID_PROVIDER_URL", "请填写有效的供应商接口地址")
    try:
        parsed = urlsplit(value)
        _ = parsed.port
        valid = parsed.scheme in schemes and parsed.hostname and parsed.username is None and not parsed.fragment
    except ValueError:
        valid = False
    if not valid:
        raise AppError(400, "INVALID_PROVIDER_URL", "请填写有效的供应商接口地址")
    return value


def route(base: str, path: str, version: str = "") -> str:
    parsed = urlsplit(base)
    prefix = parsed.path.rstrip("/")
    if version and prefix.rsplit("/", 1)[-1] != version:
        prefix += "/" + version
    return urlunsplit(parsed._replace(path=f"{prefix}/{path.lstrip('/')}"))


def change_scheme(base: str, *, websocket: bool) -> str:
    parsed = urlsplit(base)
    secure = parsed.scheme in {"https", "wss"}
    scheme = ("wss" if secure else "ws") if websocket else ("https" if secure else "http")
    return urlunsplit(parsed._replace(scheme=scheme))


def with_params(base: str, params: Mapping) -> str:
    parsed = urlsplit(base)
    query = dict(parse_qsl(parsed.query, keep_blank_values=True))
    query.update(params)
    return urlunsplit(parsed._replace(query=urlencode(query, doseq=True)))


def require_key(value: str, *, optional: bool = False) -> str:
    key = value.strip()
    if not key and not optional:
        raise AppError(400, "PROVIDER_NOT_CONFIGURED", "请在设置中填写供应商 API 密钥")
    if any(ord(char) < 33 or ord(char) > 126 for char in key):
        raise AppError(400, "INVALID_PROVIDER_KEY", "供应商密钥含有无效字符")
    return key


def invalid_response() -> AppError:
    return AppError(502, "PROVIDER_INVALID_RESPONSE", "供应商返回了无法解析的响应")


async def request_json(client: httpx.AsyncClient, method: str, url: str, **kwargs) -> dict | list:
    response = None
    for attempt in range(3):
        try:
            response = await client.request(method, url, **kwargs)
            break
        except httpx.TimeoutException:
            if attempt == 0:
                continue
            raise AppError(502, "PROVIDER_TIMEOUT", "供应商响应超时") from None
        except (httpx.ConnectError, httpx.RemoteProtocolError):
            if attempt < 2:
                await asyncio.sleep(0.2 * (attempt + 1))
                continue
            raise AppError(502, "PROVIDER_UNREACHABLE", "无法连接供应商接口") from None
        except (httpx.HTTPError, ValueError):
            raise AppError(502, "PROVIDER_UNREACHABLE", "无法连接供应商接口") from None
    if not response.is_success:
        raise UpstreamRejected(response.status_code, extract_error_detail(response, kwargs.get("headers")))
    try:
        data = response.json()
    except ValueError:
        raise invalid_response() from None
    if not isinstance(data, (dict, list)):
        raise invalid_response()
    return data
