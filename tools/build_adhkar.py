"""Build adhkar.js for the Tasbeeh app.

Sources:
  - rn0x/Adhkar-json: Hisn al-Muslim Arabic text + per-dhikr recordings (audio/<rn>.mp3)
  - M-AI-C/hisnulmuslim (Hugging Face): transliteration, English translation and reference
  - api.alquran.cloud: Quran verses (Uthmani text, Sahih International)
Usage: build_adhkar.py <dir with hisn_en.json, adhkar.json, matched.json, quran.json> <out adhkar.js> <review.txt>
"""
import json, re, sys, difflib

D = sys.argv[1]
hf = json.load(open(D + "/hisn_en.json", encoding="utf-8"))
rn = json.load(open(D + "/adhkar.json", encoding="utf-8"))
quran = json.load(open(D + "/quran.json", encoding="utf-8"))
review = []


def norm(s):
    s = re.sub(r"[ً-ٰٟـۖ-ۭ]", "", s)
    s = re.sub(r"[أإآٱ]", "ا", s).replace("ة", "ه").replace("ى", "ي")
    return re.sub(r"[^ء-ي]", "", s)


# ---------- match each rn0x entry to its English row, preferring a row from the same chapter ----------
hfn = [norm(r["arabic"]) for r in hf]
RN = {}
for ch in rn:
    for it in ch["array"]:
        RN[it["filename"]] = {"ch": ch["id"], "chname": ch["category"], "ar": it["text"], "count": it["count"]}
order = list(RN)
for k in order:
    a = norm(re.sub(r"\[[^\]]*\]", "", RN[k]["ar"]))[:150]
    scores = []
    for i, h in enumerate(hfn):
        if h:
            scores.append((difflib.SequenceMatcher(None, a, h[:150], autojunk=False).ratio(), i))
    scores.sort(reverse=True)
    RN[k]["cands"] = [i for s, i in scores if s >= scores[0][0] - 0.03]
    RN[k]["score"] = scores[0][0]
# chapter -> most common HF title among confident matches
chtitle = {}
for k in order:
    r = RN[k]
    if r["score"] > 0.9 and len(r["cands"]) == 1:
        chtitle.setdefault(r["ch"], []).append(hf[r["cands"][0]]["title"])
chtitle = {c: max(set(t), key=t.count) for c, t in chtitle.items()}
for k in order:
    r = RN[k]
    same = [i for i in r["cands"] if hf[i]["title"] == chtitle.get(r["ch"])]
    r["hf"] = (same or r["cands"])[0]


# ---------- text cleanup ----------
COUNT_WORDS = r"(مر[ةه]|مرات|مرَّ|ثلاث|سبع|عشر|مائ|مئ|أربع|اربع|إذا أصبح|إذا أمسى|في اليوم)"


def strip_count_notes(s):
    # remove parenthesised notes such as (ثلاثَ مرَّاتٍ) without touching (( ))
    return re.sub(r"(?<!\()\((?!\()([^()]*)\)(?!\))", lambda m: "" if re.search(COUNT_WORDS, norm(m.group(1)) or m.group(1)) or re.search(COUNT_WORDS, m.group(1)) else m.group(0), s)


def clean_ar(s):
    s = strip_count_notes(s)
    # brackets hold evening wording (dropped here, written out separately) or optional words (kept)
    s = re.sub(r"\[([^\]]*)\]", lambda m: "" if "أمسى" in m.group(1) or "امسى" in m.group(1) else m.group(1), s)
    if "((" in s:
        parts = re.findall(r"\(\((.*?)\)\)", s, flags=re.S)
        if parts:
            s = " ".join(parts)
    s = s.replace("((", "").replace("))", "")
    s = s.replace("(", "").replace(")", "")  # single brackets only wrap the text or an optional word
    s = re.sub(r"\.{2,}|…", "", s)
    s = re.sub(r"\s+", " ", s).strip()
    s = re.sub(r"\s+([،,])", r"\1", s)
    s = re.sub(r"^[\s.,،:!]+|[\s.,،:!]+$", "", s)
    return s


def cut(s, start=None, end=None):
    """Cut an Arabic string between two markers given without diacritics (end marker is included)."""
    idx = [i for i, c in enumerate(s) if norm(c)]
    flat = "".join(norm(s[i]) for i in idx)
    a, b = 0, len(s)
    if start:
        p = flat.find(norm(start))
        if p < 0:
            raise ValueError("start marker not found: " + start)
        a = idx[p]
    if end:
        p = flat.find(norm(end), (flat.find(norm(start)) if start else 0))
        if p < 0:
            raise ValueError("end marker not found: " + end)
        b = idx[p + len(norm(end)) - 1] + 1
        while b < len(s) and re.match(r"[ً-ٰٟ]", s[b]):
            b += 1
    return re.sub(r"^[\s.,،:]+|[\s.,،:]+$", "", s[a:b])


TRANSLIT_CH = re.compile(r"[āīūḥṣḍṭẓĀĪŪḤṢḌṬẒ`’']")


STOP = set("the and of is to you your my me from for with by his he him who are be that there all upon our us we which what no not nor o i it this as has have will on so do does any one".split())


def is_translit(line):
    words = re.findall(r"[A-Za-zāīūḥṣḍṭẓĀĪŪḤṢḌṬẒ`’'‘-]+", line)
    if not words:
        return False
    stops = sum(1 for w in words if w.lower().strip("'’‘`") in STOP)
    marked = sum(1 for w in words if TRANSLIT_CH.search(w))
    if marked >= 3 and marked >= stops:
        return True
    if stops / len(words) >= 0.2:
        return False
    return bool(TRANSLIT_CH.search(line) or "‘" in line or (stops == 0 and len(words) >= 2))


def parse_en(txt, drop=()):
    """Split the English field into transliteration, translation and reference, line by line."""
    txt = txt.replace("\r", "").strip()
    pos = txt.rfind("Reference")
    ref = re.sub(r"^Reference\s*:?\s*", "", txt[pos:]) if pos >= 0 else ""
    body = txt[:pos] if pos >= 0 else txt
    tr, en = [], []
    for line in body.split("\n"):
        line = line.strip()
        if not line or line.startswith("Reference") or any(d in line for d in drop):
            continue
        if is_translit(line):
            tr.append(line)
        elif line.endswith(":") or re.match(r"^\[?(Also|Then|After|When you|Whoever)\b", line) and line.endswith((":", ":]")):
            continue  # instructions such as "then say:"
        else:
            en.append(line)
    nblocks = len([p for p in re.split(r"\n\s*\n", body) if p.strip()])
    return "\n".join(tr), "\n".join(en), ref, nblocks


def tidy(s):
    s = re.sub(r"\((?:[Rr]ecite|each said|[Tt]hree times|[Ss]even times|[Oo]ne hundred|Ayat al-Kursi|Say:?\)|[^)]*in Arabic)[^)]*\)?", "", s)
    s = re.sub(r"\[(?:[Tt]o be said|Also|[Ss]ay|then say|three times|seven times)[^\]]*\]?", "", s)
    s = re.sub(r"\[[^\]]*\bsay:?\]", "", s)
    s = re.sub(r"\s?-?\s?\[then mention the thing to be decided\]", " …", s)
    s = re.sub(r"(?<=[A-Za-z\.,;’'\)\]])\s?[1-4](?=\s|$|[.,;])", "", s)  # footnote numbers
    s = re.sub(r"\s*\n\s*", " ", s)
    s = re.sub(r"\s{2,}", " ", s).strip()
    s = re.sub(r"\s+([.,;])", r"\1", s)
    s = re.sub(r"\.(\s*\.)+", ".", s)
    return s


def tidy_ref(s):
    # footnotes that only give the evening wording are shown as the evening item instead
    parts = re.split(r"(?:^|\s)(?=[1-4]\s?[A-Z\"'(])", s.strip())
    parts = [p for p in parts if not re.match(r"^[1-4]?\s?(When you say this in the evening|For evening recitation)", p.strip())]
    s = " ".join(parts)
    s = re.sub(r"(^|\s)[1-4]\s?(?=[A-Z\"'(])", r"\1", s)
    s = re.sub(r"\s*\n\s*", " ", s)
    s = s.replace("j§", "ﷺ").replace("«fe", "(RA)")
    return re.sub(r"\s{2,}", " ", s).strip()


def short_name(tr):
    first = re.split(r"[\n]", tr.strip())[0]
    first = re.sub(r"\[[^\]]*\]?", "", first).strip()
    first = re.sub(r"^[\[(]+|[\])]+$", "", first).strip(" ,.;:'")
    words = first.split()
    name = " ".join(words[:6])
    return name.rstrip(",.;:")


# ---------- items ----------
P = {}
# trimmed recordings already in the app repo
TRIMMED = {"240": "sub", "241": "akb", "245": "tah", "91": "sbh", "128": "hsb", "124": "yun", "96": "atb", "216": "kal",
           "83": "hsy", "86": "bsm", "87": "rdt", "93": "whd", "94": "adk", "79": "sys", "82": "afi", "53": "ibr"}
AUDIO_NEEDED = set()


def hisn(k, key=None, name=None, ar=None, start=None, end=None, tr=None, en=None, note=None, audio=True, n=None, drop=(), raw=False):
    r = RN[k]
    h = hf[r["hf"]]
    ptr, pen, pref, nb = parse_en(h["english"], drop)
    base = re.sub(r"\s+", " ", strip_count_notes(r["ar"]).replace("((", "").replace("))", "")) if raw else clean_ar(r["ar"])
    a = base if ar is None else ar
    if start or end:
        a = cut(a, start, end)
    item = {
        "ar": a,
        "name": name or short_name(ptr),
        "tr": tidy(tr if tr is not None else ptr),
        "en": tidy(en if en is not None else pen),
        "ref": tidy_ref(pref),
        "src": "Hisn al-Muslim",
    }
    if note:
        item["note"] = note
    if n:
        item["n"] = n
    if audio:
        if k in TRIMMED:
            item["au"] = "audio/" + TRIMMED[k] + ".mp3"
        else:
            item["au"] = "rn/" + k  # streamed from rn0x/Adhkar-json via jsDelivr (see AUDIO_CDN in app.js)
            AUDIO_NEEDED.add(k)
    key = key or "h" + k
    flag = []
    if nb > 2 and tr is None and en is None:
        flag.append("EN-BLOCKS=%d" % nb)
    if not item["en"]:
        flag.append("NO-EN")
    if re.match(r"^(قال|كان|اذا|يقول|يبدا|عن|وقال|يكبر|ضع|يجمع|يقرا|من)", norm(a)):
        flag.append("NARRATIVE?")
    review.append(f"[{key}] rn{k} hf{r['hf']} {('/'.join(flag)) or 'ok'}\n  NAME {item['name']}\n  AR {item['ar']}\n  TR {item['tr'][:160]}\n  EN {item['en'][:200]}\n  REF {item['ref'][:120]}\n")
    P[key] = item
    return key


def own(key, ar, name, tr, en, ref, ref_from=None, au=None, src=None):
    if ref_from:
        ref = tidy_ref(parse_en(hf[RN[ref_from]["hf"]]["english"])[2])
    P[key] = {"ar": ar, "name": name, "tr": tr, "en": en, "ref": ref, "src": src or ("Hisn al-Muslim" if ref_from else "")}
    if au:
        P[key]["au"] = au
    review.append(f"[{key}] own\n  AR {ar}\n  REF {P[key]['ref'][:120]}\n")
    return key


def qd(key, name, verses, start=0, end=None, en="", tr=""):
    """Quranic dua: verses like ['2:201'], start/end word index within the first/last verse."""
    words = []
    for i, v in enumerate(verses):
        w = quran[v]["ar"].split(" ")
        if i == 0:
            w = w[start:]
        if i == len(verses) - 1 and end is not None:
            w = w[: end - (start if len(verses) == 1 else 0)]
        words.append(" ".join(w))
    ar = " ".join(words)
    qref = [[int(x) for x in v.split(":")] for v in verses]
    s, a0 = qref[0]
    label = f"{s}:{a0}" + (f"–{qref[-1][1]}" if len(qref) > 1 else "")
    P[key] = {"ar": ar, "name": name, "tr": tr, "en": en, "ref": "Qur'an " + label, "src": "Qur'an", "q": qref, "quran": True}
    review.append(f"[{key}] quran {label}\n  AR {ar}\n")
    return key


# --- short phrases (counted most) ---
sub = hisn("240", key="sub", name="SubhanAllah", tr="Subḥānallāh", en="Glory is to Allah.")
akb = hisn("241", key="akb", name="Allahu Akbar", tr="Allāhu akbar", en="Allah is the Most Great.")
tah = hisn("245", key="tah", name="La ilaha illallah", tr="Lā ilāha illallāh", en="There is none worthy of worship but Allah.")
for k in (sub, akb, tah):
    P[k]["ref"] = tidy_ref(parse_en(hf[RN["261"]["hf"]]["english"])[2])
    P[k]["why"] = "One of the four words most beloved to Allah."
ham = own("ham", "الْحَمْدُ لِلَّهِ", "Alhamdulillah", "Alḥamdu lillāh", "All praise is for Allah.", "", ref_from="261")
P[ham]["why"] = "One of the four words most beloved to Allah."
ast = own("ast", "أَسْتَغْفِرُ اللَّهَ", "Astaghfirullah", "Astaghfirullāh", "I seek Allah’s forgiveness.", "", ref_from="253")
hwl = own("hwl", "لَا حَوْلَ وَلَا قُوَّةَ إِلَّا بِاللَّهِ", "La hawla wa la quwwata illa billah", "Lā ḥawla wa lā quwwata illā billāh",
          "There is no might and no power except with Allah.", "", ref_from="260")
P[hwl]["why"] = "A treasure from the treasures of Paradise."
sbz = own("sbz", "سُبْحَانَ اللَّهِ وَبِحَمْدِهِ، سُبْحَانَ اللَّهِ الْعَظِيمِ", "SubhanAllahi wa bihamdihi, SubhanAllahil-Azim",
          "Subḥānallāhi wa biḥamdihi, subḥānallāhil-`aẓīm", "Glory is to Allah and praise is to Him; glory is to Allah the Magnificent.", "", ref_from="256")
P[sbz]["why"] = "Two words light on the tongue, heavy on the scale, beloved to the Most Merciful."
szm = own("szm", "سُبْحَانَ اللَّهِ الْعَظِيمِ وَبِحَمْدِهِ", "SubhanAllahil-Azimi wa bihamdihi", "Subḥānallāhil-`aẓīmi wa biḥamdihi",
          "Glory is to Allah the Magnificent, and praise is to Him.", "", ref_from="259")
P[szm]["why"] = "A palm tree is planted for the reciter in Paradise."
bqy = own("bqy", "سُبْحَانَ اللَّهِ، وَالْحَمْدُ لِلَّهِ، وَلَا إِلَهَ إِلَّا اللَّهُ، وَاللَّهُ أَكْبَرُ", "SubhanAllah, walhamdulillah, wa la ilaha illallah, wallahu akbar",
          "Subḥānallāh, walḥamdu lillāh, wa lā ilāha illallāh, wallāhu akbar", "Glory is to Allah, praise is to Allah, there is none worthy of worship but Allah, and Allah is the Most Great.", "", ref_from="257")
P[bqy]["why"] = "Dearer to the Prophet ﷺ than everything the sun rises over."
sal = own("sal", "اللَّهُمَّ صَلِّ عَلَى مُحَمَّدٍ", "Allahumma salli ala Muhammad", "Allāhumma ṣalli `alā Muḥammad", "O Allah, send blessings upon Muhammad.", "", ref_from="219")
P[sal]["why"] = "Whoever sends one blessing on the Prophet ﷺ, Allah sends ten upon him."
sic = own("sic", "صَلَّى اللَّهُ عَلَيْهِ وَسَلَّمَ", "Sallallahu alayhi wa sallam", "Ṣallallāhu `alayhi wa sallam", "May Allah send blessings and peace upon him.", "", ref_from="219")
P[sic]["why"] = P[sal]["why"]
sbh = hisn("91", name="SubhanAllahi wa bihamdihi")
whd = hisn("93", name="La ilaha illallahu wahdahu")
atb = hisn("96", name="Astaghfirullaha wa atubu ilayh")
hsb = hisn("128", name="Hasbunallahu wa ni’mal wakil")
yun = hisn("124", name="Dua of Yunus")
adk = hisn("94", name="SubhanAllahi wa bihamdihi ‘adada khalqihi")
salw = hisn("98", name="Allahumma salli wa sallim ala nabiyyina Muhammad")
ast2 = hisn("250", key="astz", start="استغفر", end="واتوب اليه", name="Astaghfirullahal-Azim alladhi la ilaha illa huwa",
            tr="Astaghfirullāhal-`Aẓīmal-ladhī lā ilāha illā huwal-Ḥayyul-Qayyūmu wa atūbu ilayh",
            en="I seek the forgiveness of Allah the Mighty, besides Whom there is none worthy of worship, the Ever-Living, the Sustainer, and I repent to Him.", audio=False)
rtg = hisn("195", key="rtg", start="رب اغفر لي", end="الغفور", name="Rabbighfir li wa tub alayya",
           tr="Rabbighfir lī wa tub `alayya innaka antat-Tawwābul-Ghafūr", en="My Lord, forgive me and accept my repentance; You are the Ever-Relenting, the All-Forgiving.",
           note="The Prophet ﷺ was heard saying this 100 times in a single sitting.", audio=False)
qadr = own("qadr", "اللَّهُمَّ إِنَّكَ عَفُوٌّ تُحِبُّ الْعَفْوَ فَاعْفُ عَنِّي", "Allahumma innaka afuwwun", "Allāhumma innaka `afuwwun tuḥibbul-`afwa fa`fu `annī",
           "O Allah, You are the Pardoner and You love to pardon, so pardon me.",
           "At-Tirmidhi 3513, Ibn Majah 3850. The Prophet ﷺ taught it to ‘A’ishah (RA) for Laylat al-Qadr.", src="Sunnah")
eid = own("eid", "اللَّهُ أَكْبَرُ، اللَّهُ أَكْبَرُ، لَا إِلَهَ إِلَّا اللَّهُ، وَاللَّهُ أَكْبَرُ، اللَّهُ أَكْبَرُ، وَلِلَّهِ الْحَمْدُ", "Takbir of Eid",
          "Allāhu akbar, Allāhu akbar, lā ilāha illallāh, wallāhu akbar, Allāhu akbar, wa lillāhil-ḥamd",
          "Allah is the Most Great, Allah is the Most Great. There is none worthy of worship but Allah. Allah is the Most Great, Allah is the Most Great, and to Allah belongs all praise.",
          "Reported from Ibn Mas‘ud (RA) by Ibn Abi Shaybah. Said from the night before Eid until the Eid prayer, and in the first ten days and the days of tashriq of Dhul-Hijjah.", src="Sunnah")

# --- after prayer ---
ap_ist = hisn("66", key="h66b", start="اللهم انت السلام", name="Allahumma antas-salam",
              tr="Allāhumma antas-salām, wa minkas-salām, tabārakta yā dhal-jalāli wal-ikrām",
              en="O Allah, You are Peace and from You comes peace. Blessed are You, O Owner of majesty and honour.", audio=False)
ap67 = hisn("67", ar=clean_ar(RN["67"]["ar"]).replace(" ثلاثاً،", "،"))
ap68 = hisn("68")
ap69 = hisn("69", key="h69b", start="لا اله الا الله", name="La ilaha illallahu wahdahu (to complete 100)",
            tr="Lā ilāha illallāhu waḥdahu lā sharīka lah, lahul-mulku wa lahul-ḥamd, wa huwa `alā kulli shay’in qadīr",
            en="None has the right to be worshipped but Allah alone, He has no partner. His is the dominion and His is the praise, and He is Able to do all things.", audio=False)
QULS_DROP = ("Surahs 112", "These Surahs", "After the", "after each prayer", "Fajr and Maghrib")
ap70 = hisn("70", name="Al-Ikhlas, Al-Falaq and An-Nas", end="من الجنة و الناس", drop=QULS_DROP, note="Once after each prayer; three times after Fajr and Maghrib.")
ap71 = hisn("71", name="Ayat al-Kursi", end="وهو العلي العظيم")
ap72 = hisn("72", note="After Fajr and Maghrib.")
ap73 = hisn("73", note="After Fajr.")

# --- morning / evening ---
m = {}
m["75"] = hisn("75", name="Ayat al-Kursi")
m["76"] = hisn("76", name="Al-Ikhlas, Al-Falaq and An-Nas", drop=QULS_DROP)
m["77"] = hisn("77")
m["78"] = hisn("78", tr="Allāhumma bika aṣbaḥnā, wa bika amsaynā, wa bika naḥyā, wa bika namūt, wa ilaykan-nushūr",
               en="O Allah, by You we enter the morning and by You we enter the evening, by You we live and by You we die, and to You is the resurrection.")
m["79"] = hisn("79", name="Sayyid al-Istighfar")
m["80"] = hisn("80")
m["81"] = hisn("81")
m["82"] = hisn("82")
m["83"] = hisn("83")
for k in ["84", "85", "86", "87", "88", "89", "90", "92", "95", "97"]:
    m[k] = hisn(k)
for k, ar, tr, en in [
    ("77", "أَمْسَيْنَا وَأَمْسَى الْمُلْكُ لِلَّهِ، وَالْحَمْدُ لِلَّهِ، لَا إِلَهَ إِلَّا اللَّهُ وَحْدَهُ لَا شَرِيكَ لَهُ، لَهُ الْمُلْكُ وَلَهُ الْحَمْدُ وَهُوَ عَلَى كُلِّ شَيْءٍ قَدِيرٌ، رَبِّ أَسْأَلُكَ خَيْرَ مَا فِي هَذِهِ اللَّيْلَةِ وَخَيْرَ مَا بَعْدَهَا، وَأَعُوذُ بِكَ مِنْ شَرِّ مَا فِي هَذِهِ اللَّيْلَةِ وَشَرِّ مَا بَعْدَهَا، رَبِّ أَعُوذُ بِكَ مِنَ الْكَسَلِ وَسُوءِ الْكِبَرِ، رَبِّ أَعُوذُ بِكَ مِنْ عَذَابٍ فِي النَّارِ وَعَذَابٍ فِي الْقَبْرِ",
     "Amsaynā wa amsal-mulku lillāh, walḥamdu lillāh, lā ilāha illallāhu waḥdahu lā sharīka lah, lahul-mulku wa lahul-ḥamd, wa huwa `alā kulli shay’in qadīr. Rabbi as’aluka khayra mā fī hādhihil-laylati wa khayra mā ba`dahā, wa a`ūdhu bika min sharri mā fī hādhihil-laylati wa sharri mā ba`dahā. Rabbi a`ūdhu bika minal-kasali wa sū’il-kibar. Rabbi a`ūdhu bika min `adhābin fin-nāri wa `adhābin fil-qabr",
     "We have reached the evening and with it all dominion is Allah’s. Praise is to Allah. None has the right to be worshipped but Allah alone, Who has no partner. To Allah belongs the dominion, and to Him is the praise, and He is Able to do all things. My Lord, I ask You for the good of this night and of what comes after it, and I seek refuge in You from the evil of this night and of what comes after it. My Lord, I seek refuge in You from laziness and helpless old age. My Lord, I seek refuge in You from the punishment of the Fire and the punishment of the grave."),
    ("78", "اللَّهُمَّ بِكَ أَمْسَيْنَا، وَبِكَ أَصْبَحْنَا، وَبِكَ نَحْيَا، وَبِكَ نَمُوتُ، وَإِلَيْكَ الْمَصِيرُ",
     "Allāhumma bika amsaynā, wa bika aṣbaḥnā, wa bika naḥyā, wa bika namūt, wa ilaykal-maṣīr",
     "O Allah, by You we enter the evening and by You we enter the morning, by You we live and by You we die, and to You is the final return."),
    ("80", "اللَّهُمَّ إِنِّي أَمْسَيْتُ أُشْهِدُكَ، وَأُشْهِدُ حَمَلَةَ عَرْشِكَ، وَمَلَائِكَتَكَ، وَجَمِيعَ خَلْقِكَ، أَنَّكَ أَنْتَ اللَّهُ لَا إِلَهَ إِلَّا أَنْتَ وَحْدَكَ لَا شَرِيكَ لَكَ، وَأَنَّ مُحَمَّدًا عَبْدُكَ وَرَسُولُكَ",
     "Allāhumma innī amsaytu ush-hiduka, wa ush-hidu ḥamalata `arshik, wa malā’ikataka wa jamī`a khalqik, annaka antallāhu lā ilāha illā ant, waḥdaka lā sharīka lak, wa anna Muḥammadan `abduka wa rasūluk",
     "O Allah, I have reached the evening and call upon You, the bearers of Your Throne, Your angels and all Your creation to bear witness that You are Allah, there is none worthy of worship but You alone, You have no partner, and that Muhammad is Your slave and Your Messenger."),
    ("81", "اللَّهُمَّ مَا أَمْسَى بِي مِنْ نِعْمَةٍ أَوْ بِأَحَدٍ مِنْ خَلْقِكَ فَمِنْكَ وَحْدَكَ لَا شَرِيكَ لَكَ، فَلَكَ الْحَمْدُ وَلَكَ الشُّكْرُ",
     "Allāhumma mā amsā bī min ni`matin aw bi-aḥadin min khalqik, fa-minka waḥdaka lā sharīka lak, fa-lakal-ḥamdu wa lakash-shukr",
     "O Allah, whatever blessing has come to me or to any of Your creation this evening is from You alone, You have no partner. All praise is Yours and all thanks is Yours."),
    ("89", "أَمْسَيْنَا وَأَمْسَى الْمُلْكُ لِلَّهِ رَبِّ الْعَالَمِينَ، اللَّهُمَّ إِنِّي أَسْأَلُكَ خَيْرَ هَذِهِ اللَّيْلَةِ: فَتْحَهَا، وَنَصْرَهَا، وَنُورَهَا، وَبَرَكَتَهَا، وَهُدَاهَا، وَأَعُوذُ بِكَ مِنْ شَرِّ مَا فِيهَا وَشَرِّ مَا بَعْدَهَا",
     "Amsaynā wa amsal-mulku lillāhi Rabbil-`ālamīn. Allāhumma innī as’aluka khayra hādhihil-laylah: fatḥahā, wa naṣrahā, wa nūrahā, wa barakatahā, wa hudāhā, wa a`ūdhu bika min sharri mā fīhā wa sharri mā ba`dahā",
     "We have reached the evening and with it all dominion belongs to Allah, Lord of all that exists. O Allah, I ask You for the good of this night: its victory, its help, its light, its blessings and its guidance. I seek refuge in You from the evil that is in it and the evil that follows it."),
    ("90", "أَمْسَيْنَا عَلَى فِطْرَةِ الْإِسْلَامِ، وَعَلَى كَلِمَةِ الْإِخْلَاصِ، وَعَلَى دِينِ نَبِيِّنَا مُحَمَّدٍ صلى الله عليه وسلم، وَعَلَى مِلَّةِ أَبِينَا إِبْرَاهِيمَ، حَنِيفًا مُسْلِمًا وَمَا كَانَ مِنَ الْمُشْرِكِينَ",
     "Amsaynā `alā fiṭratil-Islām, wa `alā kalimatil-ikhlāṣ, wa `alā dīni nabiyyinā Muḥammadin (ṣallallāhu `alayhi wa sallam), wa `alā millati abīnā Ibrāhīm, ḥanīfan musliman wa mā kāna minal-mushrikīn",
     "We have reached the evening upon the natural religion of Islam, the word of sincere devotion, the religion of our Prophet Muhammad ﷺ, and the way of our father Ibrahim, who was upright and a Muslim, and was not of those who associate others with Allah."),
]:
    base = P["h" + k]
    P["h" + k + "e"] = {"ar": ar, "name": short_name(tr), "tr": tr, "en": en, "ref": base["ref"], "src": "Hisn al-Muslim"}
    review.append(f"[h{k}e] evening\n  AR {ar}\n")

# --- sleep / waking ---
sl = [hisn("99", name="Blow into the hands and recite the 3 Quls", start="بسم الله الرحمن الرحيم", end="من الجنة و الناس", drop=("Then pass",),
           note="Cup your hands, blow into them, recite the three surahs, then wipe over as much of your body as you can, starting with the head and face. Do this three times."),
      hisn("100", name="Ayat al-Kursi"), hisn("101", name="Last two verses of Al-Baqarah"),
      hisn("102"), hisn("103"), hisn("104"), hisn("105")]
sl2 = [hisn(k) for k in ["107", "108", "109", "111", "112", "113"]]
wk = [hisn(k) for k in ["1", "2", "3"]] + [hisn("4", name="Last verses of Aal ‘Imran (3:190–200)")]

# --- daily life ---
home = [hisn(k) for k in ["5", "6", "9", "10", "11", "12", "13", "14", "15", "16", "17"]]
home += [hisn("18", end="توكلنا", name="Entering the home", note="Then greet your family with salam.")]
home += [hisn("178", ar="بِسْمِ اللَّهِ", name="Before eating", tr="Bismillāh", en="In the Name of Allah.",
               note="If you forget at the start, say when you remember: بِسْمِ اللَّهِ فِي أَوَّلِهِ وَآخِرِهِ (Bismillāhi fī awwalihi wa ākhirih), “In the Name of Allah, at its beginning and its end.”")]
home += [hisn(k) for k in ["180", "181", "182"]]
home += [hisn("188", ar="الْحَمْدُ لِلَّهِ", name="When sneezing", tr="Alḥamdu lillāh", en="All praise is for Allah.",
              note="Whoever hears you says يَرْحَمُكَ اللَّهُ (Yarḥamukallāh, “May Allah have mercy on you”), and you reply يَهْدِيكُمُ اللَّهُ وَيُصْلِحُ بَالَكُمْ (Yahdīkumullāhu wa yuṣliḥu bālakum, “May Allah guide you and set your affairs right”).")]
home += [hisn(k) for k in ["193", "194", "196", "209"]]

# --- mosque & prayer ---
mosque = [hisn("19", name="Going to the mosque", ar=clean_ar(RN["19"]["ar"]).replace(")(", "، ").replace("... ", " ").strip("()"),
               tr="Allāhummaj`al fī qalbī nūran, wa fī lisānī nūran, wa fī sam`ī nūran, wa fī baṣarī nūran, wa min fawqī nūran, wa min taḥtī nūran, wa `an yamīnī nūran, wa `an shimālī nūran, wa min amāmī nūran, wa min khalfī nūran, waj`al fī nafsī nūran, wa a`ẓim lī nūran, wa `aẓẓim lī nūran, waj`al lī nūran, waj`alnī nūran, Allāhumma a`ṭinī nūran, waj`al fī `aṣabī nūran, wa fī laḥmī nūran, wa fī damī nūran, wa fī sha`rī nūran, wa fī basharī nūran. Allāhummaj`al lī nūran fī qabrī wa nūran fī `iẓāmī. Wa zidnī nūran, wa zidnī nūran, wa zidnī nūran. Wa hab lī nūran `alā nūr.",
               en="O Allah, place light in my heart, light on my tongue, light in my hearing and light in my sight, light above me and light below me, light on my right and light on my left, light before me and light behind me. Place light in my soul, make light great for me and magnify light for me, make for me light and make me light. O Allah, grant me light, and place light in my nerves, in my flesh, in my blood, in my hair and in my skin. O Allah, make for me light in my grave and light in my bones. Increase me in light, increase me in light, increase me in light. Grant me light upon light."),
hisn("20", ar="أَعُوذُ بِاللَّهِ الْعَظِيمِ، وَبِوَجْهِهِ الْكَرِيمِ، وَسُلْطَانِهِ الْقَدِيمِ، مِنَ الشَّيْطَانِ الرَّجِيمِ، بِسْمِ اللَّهِ، وَالصَّلَاةُ وَالسَّلَامُ عَلَى رَسُولِ اللَّهِ، اللَّهُمَّ افْتَحْ لِي أَبْوَابَ رَحْمَتِكَ",
                               note="Enter with your right foot first."),
          hisn("21", start="بسم الله", note="Leave with your left foot first."),
          hisn("22", start="لا حول", name="Answering the adhan",
               note="Repeat what the mu’adhdhin says, except at “Hayya ‘alas-salah” and “Hayya ‘alal-falah”, where you say this instead."),
          hisn("23", end="دينا", note="Say this after the mu’adhdhin’s testimony of faith.", drop=("[To be recited",)),
          hisn("25")]
prayer = [hisn(k) for k in ["27", "28", "29", "33", "34", "35", "38", "39", "41", "46", "48", "49", "52", "53", "55", "57", "116"]]
prayer += [hisn("119", name="After witr", tr="Subḥānal-Malikil-Quddūs", en="Glory is to the King, the Most Holy.",
                note="Say it three times after witr, raising your voice on the third time and adding: رَبِّ الْمَلَائِكَةِ وَالرُّوحِ (Rabbil-malā’ikati war-rūḥ), “Lord of the angels and the Spirit.”")]
prayer += [hisn("74", start="اللهم اني استخيرك", end="ثم ارضني به", name="Dua of Istikhara",
                drop=("Jabir bin", "Whoever seeks the counsel", "And consult them"),
                note="When you have an important decision, pray two rak‘ahs that are not obligatory, then say this, naming your matter where it says “this matter”.")]

# --- travel ---
travel = [hisn("206"),
          hisn("207", raw=True, start="الله اكبر", end="في المال والاهل", name="Dua for travel",
               drop=("Upon returning", "Ā’ibūna", "Li Rabbinā", "We return repentant", "and praising our Lord"),
               note="On returning, say it again and add: آيِبُونَ، تَائِبُونَ، عَابِدُونَ، لِرَبِّنَا حَامِدُونَ (Ā’ibūna, tā’ibūna, ‘ābidūna, li-rabbinā ḥāmidūn), “We return, repentant, worshipping and praising our Lord.”")]
travel += [hisn(k) for k in ["208", "210", "211", "212", "213", "215", "216"]]
travel += [hisn("217", start="لا اله الا الله", end="وهزم الاحزاب وحده", name="Returning from travel",
                drop=("From every elevated", "(three times)", "and then recite"),
                note="Say Allahu Akbar three times on every rise, then this.")]

# --- worry & hardship ---
worry = [hisn(k) for k in ["120", "121", "122", "123", "124", "125", "127", "128", "132", "136", "139", "144", "154", "203", "245"]]
worry += [hisn("138", ar="أَعُوذُ بِاللَّهِ مِنَ الشَّيْطَانِ الرَّجِيمِ", name="Whispers during prayer or recitation",
               tr="A`ūdhu billāhi minash-shayṭānir-rajīm", en="I seek refuge in Allah from Satan the outcast.",
               note="Then lightly spit (a dry spit) to your left three times.")]
worry += [hisn("133", ar="أَعُوذُ بِاللَّهِ", name="For doubts in faith", tr="A`ūdhu billāh", en="I seek refuge in Allah.",
               note="Then stop dwelling on the doubt.", audio=False),
          hisn("134", start="امنت", en="I believe in Allah and His Messengers.")]

# --- sickness & loss ---
sick = [hisn(k) for k in ["147", "148", "150"]]
sick += [hisn("243", start="اعوذ بالله وقدرته", end="واحاذر", name="For pain in the body",
              tr="A`ūdhu billāhi wa qudratihi min sharri mā ajidu wa uḥādhir",
              en="I seek refuge in Allah and in His Power from the evil of what I feel and what I fear.",
              note="Put your hand where it hurts and say Bismillah three times, then say this seven times.")]
sick += [hisn("162", name="Condolence"), hisn("156"), hisn("157"), hisn("160"), hisn("161"), hisn("163"), hisn("164"), hisn("165")]

# --- ramadan, hajj, weather, people ---
ram = [hisn(k) for k in ["175", "176", "177", "184", "186"]]
hajj = [hisn("233", name="Talbiyah"), hisn("235", name="Between the Yemeni corner and the Black Stone"),
        hisn("237", start="لا اله الا الله", name="Best dua of the Day of ‘Arafah")]
weather = [hisn(k) for k in ["166", "167", "168", "169", "170", "171", "172", "173", "174"]]
people = [hisn("145", name="Congratulating on a newborn", note="The parent replies with the second part.")]
people += [hisn(k) for k in ["190", "198", "200", "201", "204", "232", "205"]]
fixes = [hisn(k) for k in ["46", "57", "54"]]

# --- Quranic duas ---
Q = [
    qd("q2_201", "Rabbana atina fid-dunya hasanah", ["2:201"], 3, en="Our Lord, give us good in this world and good in the Hereafter, and protect us from the punishment of the Fire.", tr="Rabbanā ātinā fid-dunyā ḥasanatan wa fil-ākhirati ḥasanatan wa qinā `adhāban-nār"),
    qd("q2_127", "Rabbana taqabbal minna", ["2:127"], 7, en="Our Lord, accept [this] from us. Indeed You are the Hearing, the Knowing.", tr="Rabbanā taqabbal minnā innaka antas-samī`ul-`alīm"),
    qd("q2_250", "Rabbana afrigh alayna sabran", ["2:250"], 5, en="Our Lord, pour upon us patience, plant firmly our feet and give us victory over the disbelieving people.", tr="Rabbanā afrigh `alaynā ṣabran wa thabbit aqdāmanā wanṣurnā `alal-qawmil-kāfirīn"),
    qd("q2_286", "Rabbana la tu’akhidhna", ["2:286"], 14, en="Our Lord, do not take us to task if we forget or make a mistake. Our Lord, do not place upon us a burden like that which You placed upon those before us. Our Lord, do not burden us with what we cannot bear. Pardon us, forgive us and have mercy upon us. You are our Protector, so give us victory over the disbelieving people.", tr="Rabbanā lā tu’ākhidhnā in nasīnā aw akhṭa’nā, rabbanā wa lā taḥmil `alaynā iṣran kamā ḥamaltahu `alal-ladhīna min qablinā, rabbanā wa lā tuḥammilnā mā lā ṭāqata lanā bih, wa`fu `annā waghfir lanā warḥamnā, anta mawlānā fanṣurnā `alal-qawmil-kāfirīn"),
    qd("q3_8", "Rabbana la tuzigh qulubana", ["3:8"], en="Our Lord, do not let our hearts deviate after You have guided us, and grant us mercy from Yourself. Indeed, You are the Bestower.", tr="Rabbanā lā tuzigh qulūbanā ba`da idh hadaytanā wa hab lanā min ladunka raḥmah, innaka antal-wahhāb"),
    qd("q3_16", "Rabbana innana amanna", ["3:16"], 2, en="Our Lord, we have believed, so forgive us our sins and protect us from the punishment of the Fire.", tr="Rabbanā innanā āmannā faghfir lanā dhunūbanā wa qinā `adhāban-nār"),
    qd("q3_38", "Rabbi hab li min ladunka dhurriyyatan tayyibah", ["3:38"], 6, en="My Lord, grant me from Yourself a good offspring. Indeed, You are the Hearer of supplication.", tr="Rabbi hab lī min ladunka dhurriyyatan ṭayyibah, innaka samī`ud-du`ā’"),
    qd("q3_147", "Rabbanaghfir lana dhunubana", ["3:147"], 6, en="Our Lord, forgive us our sins and our excesses in our affairs, plant firmly our feet and give us victory over the disbelieving people.", tr="Rabbanaghfir lanā dhunūbanā wa isrāfanā fī amrinā wa thabbit aqdāmanā wanṣurnā `alal-qawmil-kāfirīn"),
    qd("q3_191", "Rabbana ma khalaqta hadha batila", ["3:191", "3:192"], 12, en="Our Lord, You did not create this in vain. Glory be to You! Protect us from the punishment of the Fire. Our Lord, whoever You admit to the Fire, You have disgraced, and the wrongdoers will have no helpers.", tr="Rabbanā mā khalaqta hādhā bāṭilan subḥānaka fa-qinā `adhāban-nār. Rabbanā innaka man tudkhilin-nāra faqad akhzaytah, wa mā liẓ-ẓālimīna min anṣār"),
    qd("q3_193", "Rabbana innana sami’na munadiyan", ["3:193", "3:194"], en="Our Lord, we have heard a caller calling to faith, saying ‘Believe in your Lord’, and we have believed. Our Lord, forgive us our sins, remove from us our misdeeds and let us die with the righteous. Our Lord, grant us what You promised us through Your messengers and do not disgrace us on the Day of Resurrection. You never fail in Your promise.", tr="Rabbanā innanā sami`nā munādiyan yunādī lil-īmāni an āminū birabbikum fa-āmannā, rabbanā faghfir lanā dhunūbanā wa kaffir `annā sayyi’ātinā wa tawaffanā ma`al-abrār. Rabbanā wa ātinā mā wa`adtanā `alā rusulika wa lā tukhzinā yawmal-qiyāmah, innaka lā tukhliful-mī`ād"),
    qd("q7_23", "Rabbana zalamna anfusana", ["7:23"], 1, en="Our Lord, we have wronged ourselves, and if You do not forgive us and have mercy upon us, we will surely be among the losers.", tr="Rabbanā ẓalamnā anfusanā wa in lam taghfir lanā wa tarḥamnā lanakūnanna minal-khāsirīn"),
    qd("q7_126", "Rabbana afrigh alayna sabran wa tawaffana muslimin", ["7:126"], 11, en="Our Lord, pour upon us patience and let us die as Muslims.", tr="Rabbanā afrigh `alaynā ṣabran wa tawaffanā muslimīn"),
    qd("q10_85", "Alallahi tawakkalna", ["10:85", "10:86"], 1, en="Upon Allah we rely. Our Lord, do not make us a trial for the wrongdoing people, and save us by Your mercy from the disbelieving people.", tr="`Alallāhi tawakkalnā, rabbanā lā taj`alnā fitnatan lil-qawmiẓ-ẓālimīn, wa najjinā biraḥmatika minal-qawmil-kāfirīn"),
    qd("q14_40", "Rabbij’alni muqimas-salah", ["14:40", "14:41"], en="My Lord, make me one who establishes prayer, and from my descendants too. Our Lord, accept my supplication. Our Lord, forgive me, my parents and the believers on the Day the account is established.", tr="Rabbij`alnī muqīmaṣ-ṣalāti wa min dhurriyyatī, rabbanā wa taqabbal du`ā’. Rabbanaghfir lī wa liwālidayya wa lil-mu’minīna yawma yaqūmul-ḥisāb"),
    qd("q17_24", "Rabbirhamhuma kama rabbayani saghira", ["17:24"], 7, en="My Lord, have mercy upon them as they brought me up when I was small.", tr="Rabbirḥamhumā kamā rabbayānī ṣaghīrā"),
    qd("q17_80", "Rabbi adkhilni mudkhala sidq", ["17:80"], 1, en="My Lord, let me enter a sound entrance and leave a sound exit, and grant me from Yourself a supporting authority.", tr="Rabbi adkhilnī mudkhala ṣidqin wa akhrijnī mukhraja ṣidqin waj`al lī min ladunka sulṭānan naṣīrā"),
    qd("q18_10", "Rabbana atina min ladunka rahmah", ["18:10"], 6, en="Our Lord, grant us mercy from Yourself and guide us rightly in our affair.", tr="Rabbanā ātinā min ladunka raḥmatan wa hayyi’ lanā min amrinā rashadā"),
    qd("q20_25", "Rabbishrah li sadri", ["20:25", "20:26", "20:27", "20:28"], 1, en="My Lord, expand for me my chest, ease my task for me, and untie the knot from my tongue, so that they may understand my speech.", tr="Rabbishraḥ lī ṣadrī, wa yassir lī amrī, waḥlul `uqdatan min lisānī, yafqahū qawlī"),
    qd("q20_114", "Rabbi zidni ilma", ["20:114"], 16, en="My Lord, increase me in knowledge.", tr="Rabbi zidnī `ilmā"),
    qd("q21_83", "Dua of Ayyub", ["21:83"], 5, en="Indeed, adversity has touched me, and You are the Most Merciful of the merciful.", tr="Annī massaniyaḍ-ḍurru wa anta arḥamur-rāḥimīn"),
    qd("q21_89", "Rabbi la tadharni farda", ["21:89"], 4, en="My Lord, do not leave me alone, and You are the best of inheritors.", tr="Rabbi lā tadharnī fardan wa anta khayrul-wārithīn"),
    qd("q23_109", "Rabbana amanna faghfir lana", ["23:109"], 6, en="Our Lord, we have believed, so forgive us and have mercy upon us, and You are the best of the merciful.", tr="Rabbanā āmannā faghfir lanā warḥamnā wa anta khayrur-rāḥimīn"),
    qd("q23_118", "Rabbighfir warham", ["23:118"], 1, en="My Lord, forgive and have mercy, and You are the best of the merciful.", tr="Rabbighfir warḥam wa anta khayrur-rāḥimīn"),
    qd("q25_65", "Rabbanasrif anna adhaba jahannam", ["25:65"], 2, en="Our Lord, turn away from us the punishment of Hell. Indeed, its punishment is ever adhering.", tr="Rabbanaṣrif `annā `adhāba jahannam, inna `adhābahā kāna gharāmā"),
    qd("q25_74", "Rabbana hab lana min azwajina", ["25:74"], 2, en="Our Lord, grant us from our spouses and children comfort to our eyes, and make us leaders of the righteous.", tr="Rabbanā hab lanā min azwājinā wa dhurriyyātinā qurrata a`yunin waj`alnā lil-muttaqīna imāmā"),
    qd("q26_83", "Rabbi hab li hukman", ["26:83"], en="My Lord, grant me wisdom and join me with the righteous.", tr="Rabbi hab lī ḥukman wa alḥiqnī biṣ-ṣāliḥīn"),
    qd("q27_19", "Rabbi awzi’ni an ashkura ni’matak", ["27:19"], 5, en="My Lord, enable me to be grateful for Your favour which You have bestowed upon me and my parents, and to do righteous deeds that please You, and admit me by Your mercy among Your righteous servants.", tr="Rabbi awzi`nī an ashkura ni`matakal-latī an`amta `alayya wa `alā wālidayya wa an a`mala ṣāliḥan tarḍāhu wa adkhilnī biraḥmatika fī `ibādikaṣ-ṣāliḥīn"),
    qd("q28_16", "Rabbi inni zalamtu nafsi", ["28:16"], 1, 7, en="My Lord, I have wronged myself, so forgive me.", tr="Rabbi innī ẓalamtu nafsī faghfir lī"),
    qd("q28_24", "Rabbi inni lima anzalta ilayya min khayrin faqir", ["28:24"], 7, en="My Lord, I am in need of whatever good You send down to me.", tr="Rabbi innī limā anzalta ilayya min khayrin faqīr"),
    qd("q46_15", "Rabbi awzi’ni … wa aslih li fi dhurriyyati", ["46:15"], 24, en="My Lord, enable me to be grateful for Your favour which You have bestowed upon me and my parents, and to do righteous deeds that please You, and make my offspring righteous for me. I have repented to You, and I am among those who submit.", tr="Rabbi awzi`nī an ashkura ni`matakal-latī an`amta `alayya wa `alā wālidayya wa an a`mala ṣāliḥan tarḍāhu wa aṣliḥ lī fī dhurriyyatī, innī tubtu ilayka wa innī minal-muslimīn"),
    qd("q59_10", "Rabbanaghfir lana wa li-ikhwanina", ["59:10"], 5, en="Our Lord, forgive us and our brothers who preceded us in faith, and do not put in our hearts any resentment towards those who believe. Our Lord, You are Kind and Merciful.", tr="Rabbanaghfir lanā wa li-ikhwāninal-ladhīna sabaqūnā bil-īmān, wa lā taj`al fī qulūbinā ghillan lil-ladhīna āmanū, rabbanā innaka ra’ūfun raḥīm"),
    qd("q66_8", "Rabbana atmim lana nurana", ["66:8"], 35, en="Our Lord, perfect for us our light and forgive us. Indeed, You are able to do all things.", tr="Rabbanā atmim lanā nūranā waghfir lanā, innaka `alā kulli shay’in qadīr"),
    qd("q71_28", "Rabbighfir li wa li-walidayya", ["71:28"], en="My Lord, forgive me, my parents, whoever enters my house as a believer, and the believing men and women, and do not increase the wrongdoers except in ruin.", tr="Rabbighfir lī wa liwālidayya wa liman dakhala baytiya mu’minan wa lil-mu’minīna wal-mu’mināt, wa lā tazidiẓ-ẓālimīna illā tabārā"),
]

CATS = [
    {"id": "tasbeeh", "group": "Every day", "name": "Tasbeeh", "note": "Short phrases to repeat any time. These count best by voice.",
     "items": [[sub, 33], [ham, 33], [akb, 34], [tah, 100], [ast, 100], [sbh, 100], [sbz, 100], [szm, 100], [bqy, 100], [hwl, 100], [whd, 100], [atb, 100], [sal, 100], [sic, 100], [hsb, 100], [yun, 100], [adk, 3]]},
    {"id": "salah", "group": "Every day", "name": "After prayer", "note": "After each obligatory prayer. SubhanAllah 33, Alhamdulillah 33 and Allahu Akbar 34 (Muslim, from Ka‘b ibn ‘Ujrah).",
     "items": [[ast, 3], [ap_ist, 1], [ap67, 1], [ap68, 1], [sub, 33], [ham, 33], [akb, 34], [ap71, 1], [ap70, 1], [ap72, 10], [ap73, 1]]},
    {"id": "am", "group": "Every day", "name": "Morning", "note": "From Fajr until sunrise.",
     "items": [[m["75"], 1], [m["76"], 3], [m["77"], 1], [m["78"], 1], [m["79"], 1], [m["80"], 4], [m["81"], 1], [m["82"], 3], [m["83"], 7], [m["84"], 1], [m["85"], 1], [m["86"], 3], [m["87"], 3], [m["88"], 1], [m["89"], 1], [m["90"], 1], [sbh, 100], [m["92"], 10], [whd, 100], [adk, 3], [m["95"], 1], [atb, 100], [salw, 10]]},
    {"id": "pm", "group": "Every day", "name": "Evening", "note": "From Asr until sunset.",
     "items": [[m["75"], 1], [m["76"], 3], ["h77e", 1], ["h78e", 1], [m["79"], 1], ["h80e", 4], ["h81e", 1], [m["82"], 3], [m["83"], 7], [m["84"], 1], [m["85"], 1], [m["86"], 3], [m["87"], 3], [m["88"], 1], ["h89e", 1], ["h90e", 1], [sbh, 100], [m["92"], 10], [m["97"], 3], [atb, 100], [salw, 10]]},
    {"id": "sleep", "group": "Every day", "name": "Before sleep", "note": "SubhanAllah 33, Alhamdulillah 33 and Allahu Akbar 34 are from the hadith of Fatimah (RA) (Bukhari, Muslim).",
     "items": [[sl[0], 3], [sl[1], 1], [sl[2], 1], [sl[3], 1], [sl[4], 1], [sl[5], 3], [sl[6], 1], [sub, 33], [ham, 33], [akb, 34]] + [[k, 1] for k in sl2]},
    {"id": "wake", "group": "Every day", "name": "Waking up", "items": [[k, 1] for k in wk]},
    {"id": "istighfar", "group": "Collections", "name": "Forgiveness", "note": "Seeking Allah’s forgiveness and turning back to Him.",
     "items": [[ast, 100], [atb, 100], [ast2, 3], [rtg, 100], [m["79"], 1], ["h57", 1], ["h46", 1], ["q7_23", 1], ["q28_16", 1]]},
    {"id": "salawat", "group": "Collections", "name": "Salawat", "note": "Send abundant blessings on the Prophet ﷺ, especially on Friday.",
     "items": [[sal, 100], [sic, 100], [salw, 10], ["h53", 10], ["h54", 1]]},
    {"id": "quran", "group": "Collections", "name": "Duas from the Qur’an", "items": [[k, 1] for k in Q]},
    {"id": "home", "group": "Through the day", "name": "Home and daily life", "items": [[k, 1] for k in home]},
    {"id": "masjid", "group": "Through the day", "name": "Mosque and adhan", "items": [[k, 1] for k in mosque]},
    {"id": "prayer", "group": "Through the day", "name": "Inside the prayer", "items": [[k, 3 if k in ("h33", "h41", "h119") else 1] for k in prayer]},
    {"id": "travel", "group": "Through the day", "name": "Travel", "items": [[k, 1] for k in travel]},
    {"id": "worry", "group": "Through the day", "name": "Worry and hardship", "items": [[k, 1] for k in worry] + [["q21_83", 1]]},
    {"id": "sick", "group": "Through the day", "name": "Illness and loss", "items": [[k, 7 if k in ("h148", "h243") else 1] for k in sick]},
    {"id": "people", "group": "Through the day", "name": "With others", "items": [[k, 1] for k in people]},
    {"id": "weather", "group": "Through the day", "name": "Rain and weather", "items": [[k, 1] for k in weather]},
    {"id": "ramadan", "group": "Seasons", "name": "Ramadan and fasting", "items": [[k, 1] for k in ram] + [[qadr, 100]]},
    {"id": "hajj", "group": "Seasons", "name": "Hajj, ‘Umrah and Eid", "items": [[hajj[0], 1], [hajj[1], 1], [hajj[2], 100], [eid, 3]]},
    {"id": "friday", "group": "Seasons", "name": "Friday", "note": "Send abundant salawat and read Surah al-Kahf on Friday.",
     "items": [[sal, 100], [sic, 100], ["h53", 10], [ast, 100]]},
]
# Plain-English titles for duas tied to a moment; the transliteration is still shown under the Arabic
NAMES = {
    "h1": "On waking up", "h2": "Waking at night", "h3": "On waking up (2)",
    "h5": "Getting dressed", "h6": "Wearing new clothes", "h9": "Before undressing", "h10": "Entering the toilet",
    "h11": "Leaving the toilet", "h12": "Before wudu", "h13": "After wudu", "h14": "After wudu (2)", "h15": "After wudu (3)",
    "h16": "Leaving the home", "h17": "Leaving the home (2)", "h180": "After eating", "h181": "After eating (2)",
    "h182": "Guest’s dua for the host", "h193": "When angry", "h194": "On seeing someone in difficulty",
    "h196": "Ending a gathering", "h209": "Entering the market", "h20": "Entering the mosque", "h21": "Leaving the mosque",
    "h23": "After the shahadah in the adhan", "h25": "After the adhan",
    "h27": "Opening dua of the prayer", "h28": "Opening dua (2)", "h29": "Opening dua (3)", "h33": "In ruku‘", "h34": "In ruku‘ (2)",
    "h35": "In ruku‘ (3)", "h38": "Rising from ruku‘", "h39": "After rising from ruku‘", "h41": "In sujud", "h46": "In sujud (2)",
    "h48": "Between the two sajdahs", "h49": "Between the two sajdahs (2)", "h52": "Tashahhud", "h53": "Salawat Ibrahimiyya",
    "h54": "Salawat on the Prophet’s family", "h55": "Before salam", "h57": "Before salam (2)", "h116": "Qunut of witr",
    "h206": "Riding a vehicle", "h208": "Entering a town", "h210": "When the vehicle stumbles", "h211": "Traveller to those staying",
    "h212": "Seeing off a traveller", "h213": "Seeing off a traveller (2)", "h215": "Traveller before dawn", "h216": "Stopping on a journey",
    "h120": "For grief and anxiety", "h121": "For worry and sorrow", "h122": "In distress", "h123": "In distress (2)",
    "h124": "Dua of Yunus", "h125": "In distress (3)", "h127": "Facing an enemy", "h132": "When afraid of people", "h136": "For debt",
    "h139": "When things are difficult", "h144": "When something goes wrong", "h154": "At a calamity", "h203": "Fear of shirk",
    "h245": "When startled", "h147": "Visiting the sick", "h148": "Visiting the sick (7 times)", "h150": "When very ill",
    "h156": "Funeral prayer", "h157": "Funeral prayer (2)", "h160": "Funeral prayer for a child", "h161": "Funeral prayer for a child (2)",
    "h163": "Placing the deceased in the grave", "h164": "After burial", "h165": "Visiting graves",
    "h166": "Strong wind", "h167": "Strong wind (2)", "h168": "On hearing thunder", "h169": "Praying for rain", "h170": "Praying for rain (2)",
    "h171": "Praying for rain (3)", "h172": "When it rains", "h173": "After rain", "h174": "Asking for clear skies",
    "h175": "On seeing the new moon", "h176": "Breaking the fast", "h177": "Breaking the fast (2)", "h184": "Breaking fast at someone’s home",
    "h186": "When insulted while fasting", "h190": "To newlyweds", "h198": "Thanking someone", "h200": "To someone who loves you for Allah",
    "h201": "When someone offers you their wealth", "h204": "Replying to “Barakallahu fik”", "h232": "When praised", "h205": "Against bad omens",
    "h112": "Turning over in the night", "h128": "Hasbunallahu wa ni’mal wakil", "h113": "Fear or unease in sleep", "h134": "For doubts in faith (2)",
}
for k, v in NAMES.items():
    if k in P:
        P[k]["name"] = v

used = {k for c in CATS for k, *_ in c["items"]}
missing = [k for k in used if k not in P]
if missing:
    raise SystemExit("missing items: %s" % missing)
P = {k: v for k, v in P.items() if k in used}
js = "// Generated by build_adhkar.py from Hisn al-Muslim (rn0x/Adhkar-json + M-AI-C/hisnulmuslim) and the Qur'an (alquran.cloud). Edit the script, not this file.\n"
js += "window.ADHKAR=" + json.dumps({"P": P, "CATS": CATS}, ensure_ascii=False, separators=(",", ":")) + ";\n"
open(sys.argv[2], "w", encoding="utf-8").write(js)
open(sys.argv[3], "w", encoding="utf-8").write("\n".join(review))
open(D + "/audio_needed.txt", "w").write("\n".join(sorted(a for a in AUDIO_NEEDED if a in {k[1:] for k in used if k.startswith("h")})))
print(len(P), "items,", sum(len(c["items"]) for c in CATS), "entries,", len(CATS), "categories,", len(js) // 1024, "KB")
