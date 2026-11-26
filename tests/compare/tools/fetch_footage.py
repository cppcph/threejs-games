# 下载对照用的实拍素材（Wikimedia Commons，公有领域 / 知识共享许可），不放进仓库
#   python3 tests/compare/tools/fetch_footage.py <输出目录>
# 共享出口常被限流（HTTP 429）：逐个下载，失败时指数退避
import hashlib, os, subprocess, sys, time, urllib.parse

UA = "OceanFootageStudy/1.0 (generic research client; curl)"
OUT = sys.argv[1] if len(sys.argv) > 1 else "footage"
JOBS = [  # (Commons 文件名, 转码版本；None = 原文件, 许可)
    *[(f"Beaufort_scale_{i}.jpg", None, "NOAA，公有领域") for i in range(13)],
    ("Elan_431.webm", "480p.vp9.webm", "jurijfranko，CC BY 3.0"),
    ("Ocean_surface_waves.ogv", "360p.vp9.webm", "CC0"),
]

def url_for(name, variant):
    h = hashlib.md5(name.encode()).hexdigest()
    enc = urllib.parse.quote(name)
    base = f"https://upload.wikimedia.org/wikipedia/commons"
    return f"{base}/{h[0]}/{h[:2]}/{enc}" if variant is None else f"{base}/transcoded/{h[0]}/{h[:2]}/{enc}/{enc}.{variant}"

os.makedirs(OUT, exist_ok=True)
for name, variant, lic in JOBS:
    dst = os.path.join(OUT, name + ("" if variant is None else "." + variant))
    if os.path.exists(dst) and os.path.getsize(dst) > 10000:
        continue
    wait = 30
    for attempt in range(7):
        r = subprocess.run(["curl", "-s", "--max-time", "600", "-H", "User-Agent: " + UA, "-o", dst, "-w", "%{http_code}",
                            url_for(name, variant)], capture_output=True, text=True)
        code = r.stdout.strip()
        print(f"{name} [{lic}] → {code}", flush=True)
        if code == "200":
            break
        if os.path.exists(dst):
            os.remove(dst)
        if code == "404":
            break
        time.sleep(wait)
        wait = min(wait * 2, 600)
    time.sleep(5)
