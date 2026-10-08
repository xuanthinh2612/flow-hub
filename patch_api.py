import sys
path = 'flowhub/api.py'
with open(path, 'r', encoding='utf-8') as f:
    text = f.read()

import re

# Add import if missing
if 'APIKeyHeader' not in text:
    text = text.replace('from fastapi import APIRouter', 'from fastapi.security import APIKeyHeader\nfrom fastapi import APIRouter')

# Replace require_key function
old_func = '''def require_key(request: Request) -> None:
    core = core_of(request)
    if not core.config.auth_enabled:
        return
    key = request.headers.get("x-api-key") or request.query_params.get("key") or ""
    if not key or not secrets.compare_digest(key, core.api_key):
        raise HTTPException(401, "Thiếu hoặc sai API key (header X-API-Key)")'''

# Account for Mojibake if necessary
old_func_regex = r"def require_key\(request: Request\) -> None:\s+core = core_of\(request\)\s+if not core\.config\.auth_enabled:\s+return\s+key = request\.headers\.get\(\"x-api-key\"\) or request\.query_params\.get\(\"key\"\) or \"\"\s+if not key or not secrets\.compare_digest\(key, core\.api_key\):\s+raise HTTPException\(401, .*?\)"

new_func = '''api_key_header = APIKeyHeader(name="X-API-Key", auto_error=False)

def require_key(request: Request, header_key: Optional[str] = Depends(api_key_header)) -> None:
    core = core_of(request)
    if not core.config.auth_enabled:
        return
    key = header_key or request.headers.get("x-api-key") or request.query_params.get("key") or ""
    if not key or not secrets.compare_digest(key, core.api_key):
        raise HTTPException(401, "Thiếu hoặc sai API key (header X-API-Key)")'''

new_text = re.sub(old_func_regex, new_func, text)

if new_text != text:
    with open(path, 'w', encoding='utf-8') as f:
        f.write(new_text)
    print("Successfully patched api.py for Swagger UI auth.")
else:
    print("Could not find require_key to replace.")
