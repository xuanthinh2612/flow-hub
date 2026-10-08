import sys
path = 'flowhub/web/js/pages/create.js'
with open(path, 'r', encoding='utf-8') as f:
    text = f.read()

import re
new_text = re.sub(
    r"let text = `→ \$\{r\.key\} • \$\{r\.status === 'verified' \? 'đã xác minh' : 'CHƯA xác minh trên Flow hiện tại'\}`;",
    r"let text = `→ ${r.key}`;",
    text
)

if new_text != text:
    with open(path, 'w', encoding='utf-8') as f:
        f.write(new_text)
    print("Successfully removed status display.")
else:
    print("Could not find the target string to replace.")
