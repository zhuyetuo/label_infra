"""
upload_server.py
================
轻量上传服务，端口 8183
- 拖拽上传 MP4 + CSV 文件（自动同名配对）
- 选择目标 Label Studio 项目
- 后台自动转码 MP4，配对后批量创建任务

依赖：pip install flask requests
"""

import glob
import os
import subprocess
import sys
import threading
import time

import requests
from flask import Flask, jsonify, render_template_string, request

sys.path.insert(0, os.path.dirname(__file__))
from ls_auth import auth_headers, LS_URL

NGINX_MEDIA_URL = os.getenv("NGINX_MEDIA_URL", "http://192.168.2.140:8182")
MEDIA_DIR       = os.getenv("MEDIA_DIR",       os.path.expanduser("~/label_infra/data/media"))
TRANSCODED_DIR  = os.path.join(MEDIA_DIR, "transcoded")
PORT            = int(os.getenv("UPLOAD_PORT", "8183"))

os.makedirs(MEDIA_DIR, exist_ok=True)
os.makedirs(TRANSCODED_DIR, exist_ok=True)

app = Flask(__name__)


def get_projects() -> list:
    r = requests.get(f"{LS_URL}/api/projects/?page_size=200", headers=auth_headers(), timeout=10)
    r.raise_for_status()
    return [{"id": p["id"], "title": p["title"]} for p in r.json().get("results", [])]


def transcode(src: str, dst: str) -> bool:
    use_gpu = "h264_nvenc" in subprocess.run(
        ["ffmpeg", "-encoders"], capture_output=True, text=True).stdout

    if use_gpu:
        cmd = ["ffmpeg", "-hwaccel", "cuda", "-i", src,
               "-c:v", "h264_nvenc", "-preset", "fast", "-cq", "23",
               "-c:a", "aac", "-movflags", "+faststart", "-y", dst]
    else:
        cmd = ["ffmpeg", "-i", src,
               "-c:v", "libx264", "-preset", "fast", "-crf", "23",
               "-c:a", "aac", "-movflags", "+faststart", "-y", dst]

    result = subprocess.run(cmd, capture_output=True)
    return result.returncode == 0


def import_tasks(project_id: int, pairs: list) -> int:
    tasks = [{"data": {"video": p["video"], "csv": p["csv"]}} for p in pairs]
    r = requests.post(
        f"{LS_URL}/api/projects/{project_id}/import",
        json=tasks, headers=auth_headers(), timeout=60,
    )
    r.raise_for_status()
    return r.json().get("task_count", len(tasks))


def process_upload(files_info: list, project_id: int, job_id: str):
    """后台线程：转码 + 配对 + 导入"""
    jobs[job_id]["status"] = "processing"
    jobs[job_id]["log"] = []

    def log(msg):
        jobs[job_id]["log"].append(msg)

    # 按文件名分组
    by_name: dict = {}
    for f in files_info:
        name = f["name"]
        ext = f["ext"]
        path = f["path"]
        by_name.setdefault(name, {})[ext] = path

    pairs = []
    for name, files in by_name.items():
        if "csv" not in files:
            log(f"⚠️  {name}: 缺少 CSV，跳过")
            continue
        if "mp4" not in files:
            log(f"⚠️  {name}: 缺少 MP4，跳过")
            continue

        # 转码
        src = files["mp4"]
        dst = os.path.join(TRANSCODED_DIR, os.path.basename(src))
        log(f"🎬 转码: {name}.mp4")
        if not os.path.exists(dst):
            if not transcode(src, dst):
                log(f"❌ 转码失败: {name}.mp4")
                continue
        log(f"✅ 转码完成: {name}.mp4")

        pairs.append({
            "video": f"{NGINX_MEDIA_URL}/transcoded/{os.path.basename(dst)}",
            "csv":   f"{NGINX_MEDIA_URL}/{os.path.basename(files['csv'])}",
        })

    if not pairs:
        jobs[job_id]["status"] = "error"
        log("❌ 没有可导入的配对文件")
        return

    try:
        count = import_tasks(project_id, pairs)
        log(f"✅ 成功导入 {count} 个任务到项目 {project_id}")
        jobs[job_id]["status"] = "done"
    except Exception as e:
        log(f"❌ 导入失败: {e}")
        jobs[job_id]["status"] = "error"


jobs: dict = {}

HTML = """<!DOCTYPE html>
<html lang="zh">
<head>
<meta charset="UTF-8">
<title>数据上传</title>
<style>
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body { font-family: sans-serif; background: #1a1a2e; color: #eee; padding: 40px; }
  h1 { margin-bottom: 24px; color: #e94560; }
  .card { background: #16213e; border-radius: 12px; padding: 24px; margin-bottom: 20px; }
  label { display: block; margin-bottom: 8px; color: #aaa; font-size: 14px; }
  select, input[type=file] { width: 100%; padding: 10px; border-radius: 8px;
    border: 1px solid #333; background: #0f3460; color: #eee; font-size: 14px; }
  .drop-zone { border: 2px dashed #e94560; border-radius: 12px; padding: 40px;
    text-align: center; cursor: pointer; transition: background 0.2s; }
  .drop-zone.over { background: #0f3460; }
  .drop-zone p { color: #aaa; margin-top: 8px; font-size: 14px; }
  .file-list { margin-top: 12px; font-size: 13px; }
  .file-item { padding: 4px 0; color: #aaa; }
  .file-item .mp4 { color: #e94560; }
  .file-item .csv { color: #4ecca3; }
  button { margin-top: 20px; width: 100%; padding: 14px; border-radius: 8px;
    border: none; background: #e94560; color: #fff; font-size: 16px;
    cursor: pointer; transition: opacity 0.2s; }
  button:hover { opacity: 0.85; }
  button:disabled { opacity: 0.4; cursor: not-allowed; }
  #log { background: #0a0a1a; border-radius: 8px; padding: 16px; font-family: monospace;
    font-size: 13px; min-height: 80px; white-space: pre-wrap; color: #4ecca3; }
  .status-done { color: #4ecca3; } .status-error { color: #e94560; }
  .status-processing { color: #f6a623; }
</style>
</head>
<body>
<h1>数据上传</h1>
<div class="card">
  <label>目标项目 <a href="/" style="color:#4ecca3;font-size:12px;margin-left:8px">↻ 刷新列表</a></label>
  {% if error %}
  <div style="color:#e94560;font-size:13px;margin-bottom:8px">⚠️ 获取项目列表失败：{{ error }}</div>
  {% endif %}
  <select id="project">
    {% for p in projects %}
    <option value="{{ p.id }}">{{ p.title }} (ID: {{ p.id }})</option>
    {% endfor %}
  </select>
</div>
<div class="card">
  <label>上传文件（MP4 + CSV 同名配对，可多对）</label>
  <div class="drop-zone" id="dropZone">
    <div>📁 拖拽文件到这里，或点击选择</div>
    <p>支持同时上传多个 MP4 和 CSV 文件</p>
    <input type="file" id="fileInput" multiple accept=".mp4,.csv" style="display:none">
  </div>
  <div class="file-list" id="fileList"></div>
</div>
<button id="uploadBtn" disabled>上传并导入</button>
<div class="card" style="margin-top:20px">
  <label>处理日志</label>
  <div id="log">等待上传...</div>
</div>

<script>
const dropZone = document.getElementById('dropZone');
const fileInput = document.getElementById('fileInput');
const fileList  = document.getElementById('fileList');
const uploadBtn = document.getElementById('uploadBtn');
const logEl     = document.getElementById('log');
let selectedFiles = [];

dropZone.onclick = () => fileInput.click();
dropZone.ondragover = e => { e.preventDefault(); dropZone.classList.add('over'); };
dropZone.ondragleave = () => dropZone.classList.remove('over');
dropZone.ondrop = e => {
  e.preventDefault(); dropZone.classList.remove('over');
  handleFiles([...e.dataTransfer.files]);
};
fileInput.onchange = e => handleFiles([...e.target.files]);

function handleFiles(files) {
  selectedFiles = files.filter(f => f.name.endsWith('.mp4') || f.name.endsWith('.csv'));
  fileList.innerHTML = selectedFiles.map(f => {
    const ext = f.name.endsWith('.mp4') ? 'mp4' : 'csv';
    const size = (f.size / 1024 / 1024).toFixed(1);
    return `<div class="file-item"><span class="${ext}">[${ext.toUpperCase()}]</span> ${f.name} (${size} MB)</div>`;
  }).join('');
  uploadBtn.disabled = selectedFiles.length === 0;
}

uploadBtn.onclick = async () => {
  const projectId = document.getElementById('project').value;
  if (!projectId) return alert('请选择项目');
  uploadBtn.disabled = true;
  logEl.textContent = '上传中...';

  const form = new FormData();
  selectedFiles.forEach(f => form.append('files', f));
  form.append('project_id', projectId);

  const res = await fetch('/upload', { method: 'POST', body: form });
  const { job_id } = await res.json();

  const poll = setInterval(async () => {
    const r = await fetch('/status/' + job_id);
    const data = await r.json();
    logEl.textContent = data.log.join('\\n');
    logEl.className = data.status === 'done' ? 'status-done' :
                      data.status === 'error' ? 'status-error' : 'status-processing';
    if (data.status === 'done' || data.status === 'error') {
      clearInterval(poll);
      uploadBtn.disabled = false;
    }
  }, 1000);
};
</script>
</body>
</html>"""


@app.route("/")
def index():
    error = None
    try:
        projects = get_projects()
    except Exception as e:
        projects = []
        error = str(e)
    return render_template_string(HTML, projects=projects, error=error)


@app.route("/upload", methods=["POST"])
def upload():
    project_id = int(request.form["project_id"])
    files_info = []

    for f in request.files.getlist("files"):
        filename = f.filename
        ext = filename.rsplit(".", 1)[-1].lower()
        name = filename.rsplit(".", 1)[0]
        save_path = os.path.join(MEDIA_DIR, filename)
        f.save(save_path)
        files_info.append({"name": name, "ext": ext, "path": save_path})

    job_id = str(int(time.time() * 1000))
    jobs[job_id] = {"status": "queued", "log": []}
    threading.Thread(target=process_upload, args=(files_info, project_id, job_id), daemon=True).start()

    return jsonify({"job_id": job_id})


@app.route("/status/<job_id>")
def status(job_id):
    return jsonify(jobs.get(job_id, {"status": "not_found", "log": []}))


if __name__ == "__main__":
    from ls_auth import REFRESH_TOKEN
    if not REFRESH_TOKEN:
        raise RuntimeError("请先运行：bash label_studio/set_token.sh \"你的Personal Access Token\"")
    print(f"🚀 上传服务启动: http://0.0.0.0:{PORT}", flush=True)
    app.run(host="0.0.0.0", port=PORT, debug=False)
