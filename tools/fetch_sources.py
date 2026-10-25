"""Download the sources build_adhkar.py needs into a folder (not committed).
Usage: python tools/fetch_sources.py <dir>
"""
import json, sys, os, urllib.request

d = sys.argv[1]
os.makedirs(d, exist_ok=True)


def get(url):
    with urllib.request.urlopen(url) as r:
        return r.read().decode("utf-8")


# Hisn al-Muslim Arabic text + audio file names (rn0x/Adhkar-json), pinned to the commit the app's audio uses
open(os.path.join(d, "adhkar.json"), "w", encoding="utf-8").write(
    get("https://raw.githubusercontent.com/rn0x/Adhkar-json/93dc3fc489e4291da8816265920b3cb7e2c3b569/adhkar.json"))

# Transliteration, English and references (Hugging Face dataset M-AI-C/hisnulmuslim)
rows = []
for off in range(0, 300, 100):
    data = json.loads(get(f"https://datasets-server.huggingface.co/rows?dataset=M-AI-C/hisnulmuslim&config=default&split=train&offset={off}&length=100"))
    rows += [x["row"] for x in data["rows"]]
json.dump(rows, open(os.path.join(d, "hisn_en.json"), "w", encoding="utf-8"), ensure_ascii=False, indent=1)

# Quran verses used for the Quranic duas (Uthmani text + Sahih International)
src = open(os.path.join(os.path.dirname(__file__), "build_adhkar.py"), encoding="utf-8").read()
import re
verses = sorted(set(re.findall(r'"(\d+:\d+)"', src)), key=lambda v: tuple(map(int, v.split(":"))))
q = {}
for v in verses:
    data = json.loads(get(f"https://api.alquran.cloud/v1/ayah/{v}/editions/quran-uthmani,en.sahih"))["data"]
    q[v] = {"ar": data[0]["text"], "en": data[1]["text"]}
json.dump(q, open(os.path.join(d, "quran.json"), "w", encoding="utf-8"), ensure_ascii=False, indent=1)
print(len(rows), "Hisn rows,", len(q), "verses")
