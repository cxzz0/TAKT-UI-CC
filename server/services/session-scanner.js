'use strict';
function buildRemoteScanPy(remoteWorkDir = '/root/work') {
  const cleanRoot = String(remoteWorkDir || '/root/work').replace(/\/+$/, '') || '/root/work';
  return `
import glob, json, os

work_root = ${JSON.stringify(cleanRoot)}
try:
    os.makedirs(work_root, exist_ok=True)
except Exception:
    alt_doc = os.path.expanduser("~/Documents/work")
    alt_home = os.path.expanduser("~/work")
    work_root = alt_doc if os.path.isdir(alt_doc) else alt_home
    os.makedirs(work_root, exist_ok=True)

encoded_exact = work_root.replace("/", "-")
encoded_prefix = encoded_exact + "-"

root_label = os.path.basename(work_root) or "work"
folders = {work_root: {"path": work_root, "name": f"{root_label} (主工作区)", "sessions": []}}
for entry in sorted(os.listdir(work_root)):
    if entry.startswith(".") or entry in ("uploads", "node_modules", "__pycache__"):
        continue
    full = os.path.join(work_root, entry)
    if os.path.isdir(full):
        folders[full] = {"path": full, "name": entry, "sessions": []}

def normalize_to_top_project(raw_path):
    c = (raw_path or "").rstrip("/") or work_root
    if c == work_root:
        return work_root
    if c.startswith(work_root + "/"):
        rel = c[len(work_root) + 1:]
        top_seg = rel.split("/")[0]
        if top_seg:
            return os.path.join(work_root, top_seg)
    return work_root

def decode_project_dir(dir_name):
    if dir_name == encoded_exact or dir_name == (encoded_exact + "---"):
        return work_root
    if dir_name.startswith(encoded_prefix):
        sub = dir_name[len(encoded_prefix):]
        cand = os.path.join(work_root, sub)
        if os.path.isdir(cand):
            return normalize_to_top_project(cand)
        for existing_full in list(folders.keys()):
            if existing_full == work_root:
                continue
            existing_sub = os.path.basename(existing_full).replace("_", "-").replace(" ", "-")
            if sub == existing_sub or sub.startswith(existing_sub + "-"):
                return existing_full
    return work_root

def iter_jsonl_sample_lines(filepath, file_size):
    CHUNK = 256 * 1024
    if file_size <= CHUNK * 2:
        with open(filepath, "r", encoding="utf-8", errors="replace") as f:
            for line in f:
                yield line
    else:
        with open(filepath, "rb") as f:
            head = f.read(CHUNK).decode("utf-8", errors="replace").splitlines()
            for line in head[:-1]:
                yield line
            f.seek(max(0, file_size - CHUNK))
            tail = f.read(CHUNK).decode("utf-8", errors="replace").splitlines()
            for line in tail[1:]:
                yield line

claude_glob = os.path.expanduser("~/.claude/projects/*/*.jsonl")
for p in glob.glob(claude_glob):
    try:
        st = os.stat(p)
        if st.st_size < 20:
            continue
        sid = os.path.splitext(os.path.basename(p))[0]
        proj_dir_name = os.path.basename(os.path.dirname(p))
        cwd = decode_project_dir(proj_dir_name)
        title = ""
        ai_title = ""
        first_user = ""
        last_user = ""
        user_turns = 0
        for line in iter_jsonl_sample_lines(p, st.st_size):
            if not line.strip():
                continue
            try:
                obj = json.loads(line)
            except Exception:
                continue
            if obj.get("cwd") and isinstance(obj.get("cwd"), str):
                c = obj["cwd"].rstrip("/") or work_root
                if c.startswith(work_root):
                    cwd = normalize_to_top_project(c)
            t = obj.get("type")
            if t == "custom-title" and obj.get("customTitle"):
                title = str(obj["customTitle"]).strip()
            elif t == "summary" and obj.get("summary") and not title:
                title = str(obj["summary"]).strip()
            elif t == "ai-title" and obj.get("aiTitle"):
                ai_title = str(obj["aiTitle"]).strip()
            elif t == "user":
                msg = obj.get("message") or {}
                content = msg.get("content")
                txt = ""
                if isinstance(content, str):
                    txt = content.strip()
                elif isinstance(content, list):
                    for part in content:
                        if isinstance(part, dict) and part.get("type") == "text":
                            txt += str(part.get("text") or "")
                    txt = txt.strip()
                if txt and not txt.startswith("<local-command") and not txt.startswith("<command-name>") and not txt.startswith("<relay"):
                    user_turns += 1
                    clean_txt = " ".join(txt.split())
                    if not first_user:
                        first_user = clean_txt[:80]
                    last_user = clean_txt[:80]
        display_title = title or first_user or ai_title or f"会话 {sid[:8]}"
        cwd = normalize_to_top_project(cwd)
        if cwd not in folders:
            folders[cwd] = {
                "path": cwd,
                "name": os.path.basename(cwd) or root_label,
                "sessions": []
            }
        folders[cwd]["sessions"].append({
            "id": sid,
            "title": display_title,
            "lastPrompt": last_user,
            "cwd": cwd,
            "updatedAt": int(st.st_mtime * 1000),
            "sizeBytes": st.st_size,
            "turns": max(1, user_turns),
            "existsOnDisk": True
        })
    except Exception:
        pass

res = list(folders.values())
for f in res:
    f["sessions"].sort(key=lambda x: x["updatedAt"], reverse=True)
res.sort(key=lambda x: (0 if x["path"] == work_root else 1, x["name"].lower()))
print(json.dumps({"ok": True, "resolvedWorkRoot": work_root, "folders": res}))
`.trim();
}


module.exports = { buildRemoteScanPy };
