#!/usr/bin/env python3
"""Reformat a single-column, text-based preprint as a Nature-style reading PDF.

Python 3.10+. Install:
    pip install "pymupdf>=1.24" "reportlab>=4" "fonttools>=4.40" pyphen

Quick start:
    python paper_reformat.py convert paper.pdf -o formatted.pdf \
        --reference nature-example.pdf

Reviewable workflow (recommended):
    python paper_reformat.py extract paper.pdf -o manuscript.json
    # Inspect/edit manuscript.json: paragraphs, captions, crop boxes and anchors.
    python paper_reformat.py render manuscript.json -o formatted.pdf \
        --reference nature-example.pdf --previews preview

convert also saves OUTPUT.manuscript.json and OUTPUT.report.json. render saves
OUTPUT.report.json. JSON crop coordinates are PDF points, top-left origin; page
indices are ZERO-BASED. When editing text, also update its html field or delete
that html field; the renderer uses html when present. Keep text for verification.
Float anchors refer to body block IDs. Set force_page to
a ONE-BASED output page to override automatic placement. Output never overwrites
its input PDF. Source text is not summarized or rewritten. Figures/tables retain
original colors; tables and displayed equations are preserved as high-resolution
crops. All headings are retained. Preprint attribution is added, not Nature branding.

LIMITS: single-column digital preprints, especially bioRxiv. PDF paragraph
boundaries are inferred, not known. Inline figures, multi-column sources, scanned
pages, unusual equations and multi-page tables need manual manifest corrections.
No OCR, LLM, network calls or cloud service. Exact fonts are optional: a Nature
reference with suitable embedded fonts, or --font-dir, reproduces Harding/Graphik.
Otherwise uses Times/Helvetica. This is an assisted converter, not a universal PDF
parser. Always inspect the previews and extraction report before trusting output.
"""
from __future__ import annotations
import argparse
import collections
import hashlib
import html
import io
import json
import math
import re
import sys
import unicodedata
from pathlib import Path

try:
    import fitz
    from reportlab.pdfgen import canvas
    from reportlab.platypus import Paragraph
    from reportlab.lib.styles import ParagraphStyle
    from reportlab.pdfbase import pdfmetrics
    from reportlab.pdfbase.ttfonts import TTFont
except ImportError as exc:
    raise SystemExit('Install dependencies: pip install pymupdf reportlab fonttools pyphen') from exc

SCHEMA = 1
CAP = re.compile(r'^(Fig(?:ure)?\.?|Table)\s*(\d+)[\s.|:]')
SECTION = re.compile(r'^(Abstract|Introduction|Results|Discussion|Methods|Materials and Methods|References|Bibliography|Acknowledg[e]?ments|Supplementary.*|Extended Data.*)$', re.I)
FONT_NAMES = {
    'body': 'HardingText-Regular', 'bold': 'HardingText-Bold',
    'italic': 'HardingText-RegularItalic', 'title': 'Harding-Bold',
    'label': 'Harding-Extrabold', 'sans': 'GraphikNaturel-Regular',
    'sansbold': 'GraphikNaturel-Semibold',
}


def clean(text):
    # Expand typographic ligatures, not general scientific notation.
    for a, b in {'\ufb00':'ff','\ufb01':'fi','\ufb02':'fl','\ufb03':'ffi','\ufb04':'ffl','\u200b':'','\xad':''}.items():
        text = text.replace(a, b)
    return ''.join(unicodedata.normalize('NFKC', ch) if 0x1D400 <= ord(ch) <= 0x1D7FF else ch for ch in text)


def canonical(text):
    return re.sub(r'[\s\-‐‑–]', '', clean(text))


FALLBACK = None
MISSING_GLYPHS = set()

def P(text, style):
    """Use a Unicode fallback for unsupported glyphs without altering wording."""
    font = pdfmetrics.getFont(style.fontName)
    cmap = getattr(font.face, 'charWidths', None)
    fallback_map = getattr(pdfmetrics.getFont(FALLBACK).face, 'charWidths', {}) if FALLBACK else {}
    parts = re.split(r'(<[^>]+>)', text)
    for i, part in enumerate(parts):
        if part.startswith('<'): continue
        chars = []
        for ch in html.unescape(part):
            if ch.isspace():
                chars.append(' '); continue
            supported = ord(ch) in cmap if cmap is not None else ord(ch) < 256 or ch in '“”‘’–—†‡'
            value = html.escape(ch)
            if not supported:
                if ord(ch) in fallback_map: value = '<font name="' + FALLBACK + '">' + value + '</font>'
                else: MISSING_GLYPHS.add(ch)
            chars.append(value)
        parts[i] = ''.join(chars)
    return Paragraph(''.join(parts), style)


def sha(path):
    return hashlib.sha256(Path(path).read_bytes()).hexdigest()


def write_json(path, data):
    Path(path).parent.mkdir(parents=True, exist_ok=True)
    Path(path).write_text(json.dumps(data, ensure_ascii=False, indent=2), encoding='utf-8')


def span_html(spans):
    size = max(s['size'] for s in spans)
    baseline = max(s['origin'][1] for s in spans if s['size'] >= size - .5)
    parts = []
    for s in spans:
        t = html.escape(clean(s['text']))
        if s['size'] < .82 * size:
            tag = 'super' if s['origin'][1] < baseline else 'sub'
            t = f'<{tag}>{t}</{tag}>'
        if 'bold' in s['font'].lower():
            t = '<b>' + t + '</b>'
        if any(x in s['font'].lower() for x in ['italic', 'oblique']):
            t = '<i>' + t + '</i>'
        parts.append(t)
    return ''.join(parts)


def page_rows(page, n, top, bottom):
    """Remove page furniture and manuscript line numbers, retain rich text."""
    lines = [l for b in page.get_text('dict')['blocks'] if b['type'] == 0 for l in b['lines']]
    nums = sorted([s for l in lines for s in l['spans']
                   if s['bbox'][0] < 28 and s['text'].strip().isdigit()
                   and top <= s['bbox'][1] < page.rect.height-bottom], key=lambda s:s['origin'][1])
    groups = []
    if len(nums) >= 5:
        allspans = [s for l in lines for s in l['spans'] if s['bbox'][0] >= 28 and s['bbox'][1] >= top]
        for i, num in enumerate(nums):
            y = num['origin'][1]
            lo = (nums[i-1]['origin'][1]+y)/2 if i else top
            hi = (nums[i+1]['origin'][1]+y)/2 if i+1 < len(nums) else page.rect.height-bottom
            ss = [s for s in allspans if lo <= s['origin'][1] < hi]
            groups.append(ss)
    else:
        groups = [[s for s in l['spans'] if not(s['bbox'][0] < 28 and s['text'].strip().isdigit())]
                  for l in lines if top <= l['bbox'][1] < page.rect.height-bottom]
    rows = []
    for ss in groups:
        if not ss:
            continue
        text = clean(''.join(s['text'] for s in ss)).strip()
        rect = fitz.Rect(ss[0]['bbox'])
        for s in ss[1:]: rect |= fitz.Rect(s['bbox'])
        size = max(s['size'] for s in ss)
        bold = all('bold' in s['font'].lower() for s in ss if s['text'].strip())
        equation = rect.x0 > 75 and any('math' in s['font'].lower() for s in ss)
        rows.append({'text':text, 'html':span_html(ss), 'page':n, 'bbox':list(rect),
                     'size':size, 'bold':bold, 'equation':equation})
    return rows


def paragraphs(rows, typical_size):
    """A blank line, extra leading or heading change starts a new paragraph."""
    out, last = [], None
    for r in rows:
        if not r['text']:
            last = None
            continue
        heading = (bool(SECTION.fullmatch(r['text'])) or
                   (r['bold'] and len(r['text']) < 180) or r['size'] > typical_size*1.25)
        kind = 'equation' if r['equation'] else 'heading' if heading else 'paragraph'
        start = last is None or kind != last['kind']
        if last:
            if r['page'] == last['page']:
                gap = r['bbox'][1] - last['bbox'][3]
                if gap > typical_size*.65: start = True
                if kind == 'heading' and abs(r['size']-last['size']) > 1: start = True
            if kind == 'equation' or CAP.match(r['text']): start = True
            if re.match(r'^\d+[.\s]\s*', r['text']) and r['bbox'][0] < 45: start = True
        if start:
            out.append({'kind':kind,'text':r['text'],'html':r['html'],
                        'source_pages':[r['page']], 'bbox':r['bbox']})
        else:
            out[-1]['text'] += ' ' + r['text']
            out[-1]['html'] += ' ' + r['html']
            if r['page'] not in out[-1]['source_pages']: out[-1]['source_pages'].append(r['page'])
            if r['page'] == last['page']:
                out[-1]['bbox'] = list(fitz.Rect(out[-1]['bbox']) | fitz.Rect(r['bbox']))
        last = dict(r, kind=kind)
    return out


def overlap(a, b):
    a, b = fitz.Rect(a), fitz.Rect(b)
    inter = a & b
    return not inter.is_empty and inter.get_area()/max(a.get_area(),1) > .5


def extract(source, top=33, bottom=20):
    source = Path(source).resolve()
    doc = fitz.open(source)
    if doc.needs_pass: raise ValueError('Encrypted PDF: supply a decrypted copy.')
    warnings, rows_by_page = [], []
    for i, page in enumerate(doc):
        rr = page_rows(page, i, top, bottom)
        rows_by_page.append(rr)
        if not any(r['text'] for r in rr): warnings.append(f'Page {i+1}: no extracted text; check for scans.')
    if sum(len(r['text']) for rr in rows_by_page for r in rr) < 200:
        raise ValueError('Too little extractable text. OCR or a source document is required.')
    freq = collections.Counter(round(r['size'],1) for rr in rows_by_page for r in rr if len(r['text']) > 50)
    typical = freq.most_common(1)[0][0]
    floats, excluded, caprows = [], collections.defaultdict(list), set()
    # Caption-led figure detection supports raster figures and vector figure plates.
    for n, rr in enumerate(rows_by_page):
        page = doc[n]
        caps = [(j,CAP.match(r['text'])) for j,r in enumerate(rr) if CAP.match(r['text'])]
        for ci, (j, match) in enumerate(caps):
            label, number = match.groups(); is_table = label == 'Table'
            cap = rr[j]; candidates = []
            if is_table:
                # Only run table detection on pages with a Table caption, avoiding
                # expensive false positives in complex vector graphics.
                tables = page.find_tables().tables
                candidates = [fitz.Rect(t.bbox) for t in tables if t.bbox[1] >= cap['bbox'][1] and t.bbox[1]-cap['bbox'][3] < 100]
                if not candidates:
                    warnings.append(f'Page {n+1}: Table {number} not detected; preserved as text. Add a table crop manually.')
                    continue
                rect = min(candidates, key=lambda x:x.y0)
                nextcap = rr[caps[ci+1][0]]['bbox'][1] if ci+1 < len(caps) else page.rect.height-bottom
                foot = [r for r in rr if rect.y1 <= r['bbox'][1] < nextcap and r['text']]
                # Table notes usually directly follow the grid at a smaller size.
                for r in foot:
                    if r['size'] > typical or r['bbox'][1]-rect.y1 > 35: break
                    rect |= fitz.Rect(r['bbox'])
                rect |= fitz.Rect(cap['bbox'])
                title = cap['text']
                floats.append({'id':f'table-{number}','kind':'table','label':f'Table {number}',
                               'source_page':n,'bbox':list(rect+(-1,-1,1,1)),
                               'caption':'','caption_html':'','anchor':None,'force_page':None})
                excluded[n].append(list(rect+(-2,-2,2,2)))
                continue
            images = [fitz.Rect(im['bbox']) for im in page.get_image_info()
                      if fitz.Rect(im['bbox']).width > page.rect.width*.35 and fitz.Rect(im['bbox']).height > 75]
            above = [r for r in images if r.y0 < cap['bbox'][1] and r.y1 <= cap['bbox'][1]+25]
            if above and len(page.get_drawings()) < 50:
                rect = max(above,key=lambda x:x.get_area())
            else:
                # Conservative vector-plate heuristic: a substantial figure lives
                # above a lower-page caption and the page has many drawing paths.
                drawings = page.get_drawings()
                candidates = [fitz.Rect(d['rect']) for d in drawings if d['rect'].y0 >= top and d['rect'].y1 <= cap['bbox'][1]+2 and d['rect'].get_area() > 0]
                if len(candidates) < 15 or cap['bbox'][1] < 140:
                    warnings.append(f'Page {n+1}: Figure {number} crop uncertain; caption remains in text. Add its crop manually.')
                    continue
                rect = fitz.Rect(32,top,page.rect.width-30,cap['bbox'][1]-12)
                warnings.append(f'Figure {number}: inferred vector crop on page {n+1}; inspect it.')
            excluded[n].append(list(rect))
            # Collect caption until a blank line / new heading, using the next
            # page if the legend was split across a page boundary.
            chosen = []
            cursor_page, cursor = n, j
            while cursor_page < len(doc):
                current = rows_by_page[cursor_page]
                while cursor < len(current):
                    r = current[cursor]
                    if chosen and (not r['text'] or SECTION.fullmatch(r['text']) or CAP.match(r['text'])): break
                    chosen.append(r); caprows.add((cursor_page,cursor)); cursor += 1
                if cursor < len(current): break
                # Only continue if the caption reached the bottom of its page.
                if not chosen or chosen[-1]['bbox'][3] < doc[cursor_page].rect.height-65: break
                cursor_page += 1; cursor = 0
                if cursor_page >= len(doc): break
                first = next((r for r in rows_by_page[cursor_page] if r['text']), None)
                if not first or SECTION.fullmatch(first['text']) or CAP.match(first['text']): break
            floats.append({'id':f'figure-{number}','kind':'figure','label':f'Figure {number}',
                           'source_page':n,'bbox':list(rect),
                           'caption':' '.join(r['text'] for r in chosen),
                           'caption_html':' '.join(r['html'] for r in chosen),
                           'anchor':None,'force_page':None})
    filtered, body_chars = [], 0
    for n, rr in enumerate(rows_by_page):
        for j,r in enumerate(rr):
            if (n,j) in caprows or any(overlap(r['bbox'],rect) for rect in excluded[n]): continue
            if r['text'] in ['Figures','Tables'] and excluded[n]: continue
            filtered.append(r); body_chars += len(r['text'])
    blocks = paragraphs(filtered,typical)
    for b in blocks:
        if '\x00' in b['text'] or '\ufffd' in b['text']:
            warnings.append(f"Source contains an unencoded character on page {b['source_pages'][0]+1}: {b['text'][:120]}. Compare the original and repair this block in the manifest.")
    # Front matter ends at the Abstract heading. A few PDF generators merge titles
    # and authors; these remain editable in the manifest.
    ai = next((i for i,b in enumerate(blocks) if b['text'].strip().lower()=='abstract'), None)
    if ai is None:
        raise ValueError('No Abstract heading found. This extractor expects a single-column preprint with an Abstract heading.')
    front = blocks[:ai]
    if len(front) < 2: raise ValueError('Could not separate title/authors. Adjust extraction or prepare the JSON manually.')
    abstract = blocks[ai+1]
    body = blocks[ai+2:]
    for i,b in enumerate(body): b['id'] = f'b{i:04d}'
    for fl in floats:
        num = fl['label'].split()[-1]
        pattern = (r'(?<!Supplementary )(?<!Supplementary\s)\bFig(?:ure)?\.?\s*'+num+r'(?!\d)' if fl['kind']=='figure' else r'\bTable\s*'+num+r'(?!\d)')
        anchor = next((b['id'] for b in body if re.search(pattern,b['text'])),None)
        fl['anchor'] = anchor
        if anchor is None: warnings.append(f"{fl['label']}: no citation found; will be appended after the article text.")
    head = doc[0].get_text()
    doi = re.search(r'10\.\d{4,9}/[\w.()/-]+',head)
    date = re.search(r'version posted\s+([A-Za-z]+\s+\d{1,2},?\s+\d{4})',head)
    # Warn about multi-column source layouts instead of promising correct order.
    narrow_right = [r for rr in rows_by_page for r in rr if r['bbox'][0] > doc[0].rect.width*.45 and len(r['text'])>80]
    if len(narrow_right)>15: warnings.append('Possible multi-column source: verify all reading order manually.')
    m = {'schema_version':SCHEMA,'source_pdf':str(source),'source_sha256':sha(source),
         'metadata':{'title':front[0]['text'],'title_html':front[0]['html'],
                     'authors':front[1]['text'],'authors_html':front[1]['html'],
                     'affiliations_html':' '.join(b['html'] for b in front[2:]),
                     'abstract':abstract['text'],'abstract_html':abstract['html'],
                     'doi':doi.group().rstrip('.') if doi else '',
                     'posted':date.group(1) if date else '', 'short_title':'Preprint'},
         'layout':{'width':595.276,'height':790.866,'left':39.685,'right':32.59,'gutter':10.4,
                   'body_size':8.25,'body_leading':10.75,'figure_max_height':460},
         'blocks':body,'floats':floats,'warnings':warnings,
         'extraction':{'pages':len(doc),'body_characters':body_chars,'top_excluded':top,'bottom_excluded':bottom,
                       'note':'Paragraph boundaries and crop boxes are inferred. Review before publication or scientific use.'}}
    doc.close()
    return m


def fonts(reference, directory, cache, warnings):
    """Optional embedded CFF -> TTF conversion; preserve base Unicode glyphs."""
    cache = Path(cache); cache.mkdir(parents=True,exist_ok=True)
    if reference:
        try:
            from fontTools.cffLib import CFFFontSet
            from fontTools.fontBuilder import FontBuilder
            from fontTools.pens.ttGlyphPen import TTGlyphPen
            from fontTools.pens.cu2quPen import Cu2QuPen
            from fontTools.pens.boundsPen import BoundsPen
            from fontTools.agl import toUnicode
            ref = fitz.open(reference)
            found = {f[3].split('+')[-1]:f[0] for page in ref for f in page.get_fonts()}
            for name in FONT_NAMES.values():
                if name not in found: continue
                _,ext,_,data = ref.extract_font(found[name])
                dest = cache/(name+'.ttf')
                if ext=='ttf': dest.write_bytes(data); continue
                if ext!='cff': continue
                cff=CFFFontSet();cff.decompile(io.BytesIO(data),None);top=cff[cff.fontNames[0]]
                if list(top.FontMatrix) != [.001,0,0,.001,0,0]:
                    warnings.append(f'Unsupported font matrix for {name}; using fallback.'); continue
                gs,metrics,cmap={},{},{}
                for gn in top.charset:
                    cs=top.CharStrings[gn];pen=TTGlyphPen(None)
                    cs.draw(Cu2QuPen(pen,max_err=1,reverse_direction=True));gs[gn]=pen.glyph()
                    bounds=BoundsPen(None);cs.draw(bounds)
                    metrics[gn]=(round(cs.width),round(bounds.bounds[0]) if bounds.bounds else 0)
                    u=toUnicode(gn)
                    # Crucial: never overwrite base characters with .sup/.alt glyphs.
                    if len(u)==1 and '.' not in gn: cmap.setdefault(ord(u),gn)
                fb=FontBuilder(1000,isTTF=True);fb.setupGlyphOrder(top.charset);fb.setupCharacterMap(cmap)
                fb.setupGlyf(gs);fb.setupHorizontalMetrics(metrics);fb.setupHorizontalHeader(ascent=960,descent=-274)
                fb.setupNameTable({'familyName':name,'styleName':'Regular','uniqueFontIdentifier':name,'fullName':name,'psName':name})
                fb.setupOS2(sTypoAscender=960,sTypoDescender=-274,usWinAscent=1100,usWinDescent=300)
                fb.setupPost();fb.setupMaxp();fb.save(dest)
            ref.close()
        except Exception as exc:
            warnings.append(f'Reference font import failed: {exc}. Using available/fallback fonts.')
    defaults={'body':'Times-Roman','bold':'Times-Bold','italic':'Times-Italic','title':'Times-Bold',
              'label':'Times-Bold','sans':'Helvetica','sansbold':'Helvetica-Bold'}
    names={}
    for role,name in FONT_NAMES.items():
        candidates=([Path(directory)/(name+'.ttf')] if directory else [])+[cache/(name+'.ttf')]
        path=next((p for p in candidates if p.exists()),None)
        if path:
            pdfmetrics.registerFont(TTFont(name,str(path)));names[role]=name
        else:names[role]=defaults[role]
    for normal,bold,italic in [(names['body'],names['bold'],names['italic']),
                                (names['sans'],names['sansbold'],names['sans']),
                                (names['sansbold'],names['sansbold'],names['sansbold']),
                                (names['title'],names['title'],names['title'])]:
        pdfmetrics.registerFontFamily(normal,normal=normal,bold=bold,italic=italic,boldItalic=bold)
    return names


class Layout:
    def __init__(self,m,source,names,schedule,path):
        self.m,self.source,self.font,self.schedule=m,source,names,schedule
        l=m['layout'];self.W,self.H=l['width'],l['height'];self.left,self.right=l['left'],l['right']
        self.gap=l['gutter'];self.full=self.W-self.left-self.right;self.cw=(self.full-self.gap)/2
        self.c=canvas.Canvas(str(path),pagesize=(self.W,self.H));self.c.setTitle(m['metadata']['title']);self.c.setAuthor(m['metadata']['authors'])
        self.styles={
            'paragraph':ParagraphStyle('body',fontName=names['body'],fontSize=l['body_size'],leading=l['body_leading'],alignment=4,firstLineIndent=8.25,hyphenationLang='en_US'),
            'heading':ParagraphStyle('heading',fontName=names['bold'],fontSize=9.75,leading=12,spaceBefore=13,spaceAfter=3),
            'reference':ParagraphStyle('reference',fontName=names['sans'],fontSize=6.3,leading=8,spaceAfter=2),
            'caption':ParagraphStyle('caption',fontName=names['body'],fontSize=7,leading=9),
        }
        self.page=0;self.y=0;self.col=0;self.top=0;self.first_floor=130;self.positions={};self.float_positions={}
        self.placements=[];self.text_regions=[];self.references=False;self.sections=[];self.first_floor=130

    def rule(self,y,x=None,width=None):
        self.c.setStrokeColorRGB(.4,.4,.4);self.c.setLineWidth(.3)
        x=self.left if x is None else x
        self.c.line(x,y,x+(self.full if width is None else width),y)

    def newpage(self):
        if self.page:self.c.showPage()
        self.page+=1;self.col=0;self.y=self.H-49
        self.c.setFont(self.font['label'],14);self.c.setFillColorRGB(0,0,0);self.c.drawString(self.left,self.H-38.56,'Article')
        self.rule(self.H-44.5);self.c.setFont(self.font['sans'],7)
        footer=' | '.join(x for x in [self.m['metadata'].get('short_title','Preprint'),self.m['metadata'].get('posted',''),str(self.page)] if x)
        self.c.drawRightString(self.W-self.right,20,footer)
        for fid in self.schedule.get(self.page,[]):self.draw_float(next(f for f in self.m['floats'] if f['id']==fid))
        self.top=self.y

    def floor(self):return self.first_floor if self.page==1 else 45

    def advance(self):
        if self.col==0:self.col=1;self.y=self.top
        else:self.newpage()

    def front(self):
        self.newpage();md=self.m['metadata']
        title=P(md.get('title_html',html.escape(md['title'])),ParagraphStyle('title',fontName=self.font['title'],fontSize=26,leading=28))
        _,h=title.wrap(self.full,1000);title.drawOn(self.c,self.left,self.y-h);self.y-=h+36
        self.rule(self.y+5);my=self.y
        for text,size in [('doi: '+md.get('doi',''),6.8),('Posted: '+md.get('posted',''),8),('Preprint — not peer reviewed',7)]:
            para=P(html.escape(text),ParagraphStyle('metadata',fontName=self.font['sans'],fontSize=size,leading=10))
            _,hh=para.wrap(166,1000);para.drawOn(self.c,self.left,my-hh);my-=hh+7;self.rule(my,width=166);my-=5
        ax=self.left+self.full*.34;aw=self.W-self.right-ax
        for text,fn,fs,lead in [(md.get('authors_html',html.escape(md['authors'])),self.font['sansbold'],8,11),
                               (md.get('abstract_html',html.escape(md['abstract'])),self.font['body'],9,12)]:
            pp=P(text,ParagraphStyle('front',fontName=fn,fontSize=fs,leading=lead));_,hh=pp.wrap(aw,2000)
            pp.drawOn(self.c,ax,self.y-hh);self.y-=hh+18;self.rule(self.y+5,x=ax,width=aw)
        self.y-=3;self.rule(self.y+5);self.top=self.y
        aff=P(md.get('affiliations_html',''),ParagraphStyle('aff',fontName=self.font['sans'],fontSize=6,leading=7.8))
        _,h=aff.wrap(self.full,2000);self.first_floor=max(70,h+70)
        if self.y < self.first_floor+24:
            raise ValueError('Front matter is too long for this layout. Shorten/reposition affiliations in the manifest; no text was clipped.')
        self.rule(self.first_floor-12);aff.drawOn(self.c,self.left,self.first_floor-17-h)

    def para(self,b):
        if b['kind']=='heading' and b['text'].lower() in ['references','bibliography']:self.references=True
        sty=self.styles['heading' if b['kind']=='heading' else 'reference' if self.references else 'paragraph']
        p=P(b.get('html',html.escape(b['text'])),sty)
        _,h=p.wrap(self.cw,10000)
        if b['kind']=='heading':
            if self.y-h-35<self.floor():self.advance()
            self.y-=sty.spaceBefore;self.sections.append((b['text'],self.page))
        while True:
            room=self.y-self.floor();_,h=p.wrap(self.cw,10000)
            if h<=room:
                self.draw_text(p,b,self.y,h);self.y-=h+sty.spaceAfter;break
            split=p.split(self.cw,room)
            if not split:
                if room>=self.top-self.floor()-.1:raise ValueError(f"Cannot fit block {b['id']}; inspect its markup.")
                self.advance();continue
            q=split[0];_,qh=q.wrap(self.cw,room);self.draw_text(q,b,self.y,qh)
            self.advance()
            if len(split)==1:break
            p=split[1]

    def draw_text(self, paragraph, block, top, height):
        x=self.left+self.col*(self.cw+self.gap)
        paragraph.drawOn(self.c,x,top-height)
        self.positions.setdefault(block['id'],self.page)
        self.text_regions.append((block['id'],self.page-1,[x-1,self.H-top,x+self.cw+1,self.H-top+height]))

    def equation(self,b):
        rect=fitz.Rect(b['bbox']);scale=min(.8,self.cw/rect.width);h=rect.height*scale
        if self.y-h-8<self.floor():self.advance()
        self.positions[b['id']]=self.page
        x=self.left+self.col*(self.cw+self.gap)+(self.cw-rect.width*scale)/2
        self.placements.append((self.page-1,b['source_pages'][0],list(rect),(x,self.H-self.y,x+rect.width*scale,self.H-self.y+h)))
        self.y-=h+8

    def draw_float(self,fl):
        rect=fitz.Rect(fl['bbox']);caption=fl.get('caption_html') or html.escape(fl.get('caption',''))
        ch,parts=0,[]
        if caption:
            p=P(caption,self.styles['caption']);_,h=p.wrap(self.cw,10000);ch=math.ceil(h/18)*9
            while True:
                parts=p.split(self.cw,ch)
                if len(parts)==1 or (len(parts)==2 and parts[1].wrap(self.cw,10000)[1]<=ch):break
                ch+=9
        maxh=min(self.m['layout']['figure_max_height'],self.y-55-ch-20)
        if maxh<80:raise ValueError(f"Float {fl['id']} cannot fit; move it to a separate force_page.")
        scale=min(self.full/rect.width,maxh/rect.height);w,h=rect.width*scale,rect.height*scale
        x=self.left+(self.full-w)/2
        self.placements.append((self.page-1,fl['source_page'],list(rect),(x,self.H-self.y,x+w,self.H-self.y+h)))
        self.float_positions[fl['id']]=self.page;self.y-=h+8
        for j,p in enumerate(parts):
            _,ph=p.wrap(self.cw,10000);p.drawOn(self.c,self.left+j*(self.cw+self.gap),self.y-ph)
        self.y-=ch+12;self.rule(self.y+5)
        if self.y<70:self.y=45

    def run(self):
        self.front()
        for b in self.m['blocks']:
            if b['kind']=='equation':self.equation(b)
            else:self.para(b)
        last=max(self.schedule,default=self.page)
        while self.page<last:self.newpage()
        note={'id':'source-note','kind':'paragraph','text':'', 'html':'<b>Layout note.</b> Reformatted for reading; not a Nature publication. Original wording and figure colors are retained. Source DOI: '+html.escape(self.m['metadata'].get('doi',''))+'. See the companion extraction report for limitations.'}
        self.para(note);self.c.save()


def float_schedule(m,positions):
    schedule={};used=set()
    order={b['id']:i for i,b in enumerate(m['blocks'])}
    ordered=sorted(m['floats'],key=lambda f:(order.get(f.get('anchor'),10**9),0 if f['kind']=='figure' else 1))
    for f in ordered:
        requested=f.get('force_page')
        page=int(requested) if requested else max(2,positions.get(f.get('anchor'),max(positions.values(),default=1))+1)
        if page<2:raise ValueError('force_page must be >= 2; page 1 is reserved for front matter.')
        while page in used:
            if requested:raise ValueError('Two force_page values conflict. Put each float on its own page.')
            page+=1
        used.add(page);schedule[page]=[f['id']]
    return schedule


def render(m,output,reference=None,font_dir=None,previews=None,dpi=300,fallback_font=None):
    global FALLBACK
    FALLBACK=None;MISSING_GLYPHS.clear()
    fallback_paths=([Path(fallback_font)] if fallback_font else [])+[Path('/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf'),Path('/Library/Fonts/Arial Unicode.ttf'),Path('C:/Windows/Fonts/arial.ttf')]
    for fp in fallback_paths:
        if fp.exists():
            pdfmetrics.registerFont(TTFont('UnicodeFallback',str(fp)));FALLBACK='UnicodeFallback';break
    if m.get('schema_version')!=SCHEMA:raise ValueError('Unsupported manifest schema.')
    source=Path(m['source_pdf']).resolve();output=Path(output).resolve()
    if source==output:raise ValueError('Output must differ from the input PDF.')
    if m.get('source_sha256') and sha(source)!=m['source_sha256']:raise ValueError('Source PDF changed since extraction; re-extract or update the manifest deliberately.')
    output.parent.mkdir(parents=True,exist_ok=True)
    work=output.parent/(output.stem+'_work');work.mkdir(exist_ok=True)
    warnings=list(m.get('warnings',[]));names=fonts(reference,font_dir,work/'fonts',warnings)
    if not reference and not font_dir:warnings.append('Using Times/Helvetica substitutes. Pass --reference or --font-dir for Harding/Graphik.')
    doc=fitz.open(source)
    if reference:
        r=fitz.open(reference);m['layout']['width']=r[0].rect.width;m['layout']['height']=r[0].rect.height;r.close()
    ids=[b['id'] for b in m['blocks']];fids=[f['id'] for f in m['floats']]
    if len(ids)!=len(set(ids)) or len(fids)!=len(set(fids)):raise ValueError('Duplicate block or float IDs in manifest.')
    for f in m['floats']:
        if f.get('anchor') is not None and f['anchor'] not in ids:raise ValueError(f"Unknown anchor: {f['anchor']}")
        if not 0<=f['source_page']<len(doc):raise ValueError('Invalid source_page.')
        rect=fitz.Rect(f['bbox'])
        if rect.is_empty or not doc[f['source_page']].rect.contains(rect):raise ValueError(f"Crop out of bounds: {f['id']}")
    schedule={};converged=False
    # Several passes move floats when previous floats push their citations later.
    # Each pass reflows *all* text continuously; no forced breaks between paragraphs.
    for passno in range(8):
        engine=Layout(m,doc,names,schedule,work/'typeset.pdf');engine.run()
        next_schedule=float_schedule(m,engine.positions)
        if next_schedule==schedule:converged=True;break
        schedule=next_schedule
    if not converged:
        warnings.append('Float placement did not converge within 8 passes. Inspect placement; force_page overrides are available.')
        engine=Layout(m,doc,names,schedule,work/'typeset.pdf');engine.run()
    result=fitz.open(work/'typeset.pdf')
    for target,sp,rect,dest in engine.placements:
        pix=doc[sp].get_pixmap(matrix=fitz.Matrix(dpi/72,dpi/72),clip=fitz.Rect(rect),alpha=False)
        result[target].insert_image(fitz.Rect(dest),stream=pix.tobytes('png'))
    toc=[[1,title,page] for title,page in engine.sections if len(title)<100]
    if toc:result.set_toc(toc)
    result.save(output,garbage=4,deflate=True)
    # Read back only the actual text rectangles, avoiding inserted captions and
    # running headers. Compare after ignoring whitespace and discretionary hyphens.
    texts=collections.defaultdict(list)
    page_lines={i:[ln for block in page.get_text('dict')['blocks'] if block['type']==0 for ln in block['lines']] for i,page in enumerate(result)}
    for bid,pg,rect in engine.text_regions:
        x0,y0,x1,y1=rect
        for line in page_lines[pg]:
            selected=[sp['text'] for sp in line['spans'] if x0<=sp['origin'][0]<x1 and y0-.5<=sp['origin'][1]<y1+.1]
            if selected:texts[bid].append(''.join(selected))
    unmatched=[]
    for block in m['blocks']:
        if block['kind']=='equation':continue
        got=' '.join(texts[block['id']])
        if canonical(block['text'])!=canonical(got):
            unmatched.append({'block':block['id'],'expected':block['text'],'rendered':got})
    if unmatched:warnings.append(f'{len(unmatched)} blocks need text review; see unmatched_text. Comparison ignores whitespace and hyphens.')
    if any(ord(ch)<32 or ch=='\ufffd' for ch in MISSING_GLYPHS):warnings.append('The source has an unencoded/replacement character. Inspect and correct the relevant text in the manifest; a fallback font cannot recover the missing character.')
    display_missing=[ch for ch in sorted(MISSING_GLYPHS) if ord(ch)>=32 and ch!='\ufffd']
    if display_missing:warnings.append('Missing glyphs: '+', '.join(f'{ch} (U+{ord(ch):04X})' for ch in display_missing)+'. Supply --fallback-font with wider Unicode coverage.')
    bounds=[]
    for i,page in enumerate(result):
        for b in page.get_text('blocks'):
            if b[0]<0 or b[1]<0 or b[2]>page.rect.width+1 or b[3]>page.rect.height+1:bounds.append({'page':i+1,'bbox':b[:4]})
    if previews:
        preview=Path(previews);preview.mkdir(parents=True,exist_ok=True)
        for i,page in enumerate(result):page.get_pixmap(matrix=fitz.Matrix(1.4,1.4)).save(preview/f'page-{i+1:03}.png')
    report={'output':str(output),'pages':len(result),'fonts':names,'float_placement_converged':converged,
            'paragraph_count':sum(b['kind']=='paragraph' for b in m['blocks']),
            'block_pages':engine.positions,'float_pages':engine.float_positions,'warnings':warnings,
            'unmatched_text':unmatched,'out_of_bounds':bounds,
            'checks':'No paraphrasing is performed. This report is not proof of lossless extraction. Review the editable manifest and rendered pages against the source.'}
    write_json(output.with_suffix('.report.json'),report)
    result.close();doc.close()
    return report


def main():
    parser=argparse.ArgumentParser(description=__doc__,formatter_class=argparse.RawDescriptionHelpFormatter)
    sub=parser.add_subparsers(dest='command',required=True)
    for name in ['extract','convert','render']:
        q=sub.add_parser(name)
        q.add_argument('input',type=Path);q.add_argument('-o','--output',type=Path,required=True)
        if name!='render':
            q.add_argument('--top',type=float,default=33,help='Exclude this many points at page top (default: bioRxiv banner).')
            q.add_argument('--bottom',type=float,default=20)
        if name!='extract':
            q.add_argument('--reference',type=Path,help='Nature PDF supplying embedded Harding/Graphik fonts and page dimensions.')
            q.add_argument('--font-dir',type=Path,help='Directory with HardingText-Regular.ttf, etc. See FONT_NAMES in source.')
            q.add_argument('--previews',type=Path,help='Write rendered page PNGs to this directory.')
            q.add_argument('--fallback-font',type=Path,help='Unicode TTF fallback for scientific symbols (DejaVu Sans recommended).')
            q.add_argument('--dpi',type=int,default=300,help='Figure/table/equation crop resolution.')
    args=parser.parse_args()
    try:
        if args.command=='render':m=json.loads(args.input.read_text(encoding='utf-8'))
        else:
            m=extract(args.input,args.top,args.bottom)
            manifest=args.output if args.command=='extract' else args.output.with_suffix('.manuscript.json')
            write_json(manifest,m)
            if args.command=='extract':
                print(f"Wrote {manifest}: {len(m['blocks'])} blocks, {len(m['floats'])} figures/tables.")
                for w in m['warnings']:print('REVIEW:',w)
                return
        report=render(m,args.output,args.reference,args.font_dir,args.previews,args.dpi,args.fallback_font)
        print(f"Wrote {args.output}: {report['pages']} pages. Review {args.output.with_suffix('.report.json')}.")
        for w in report['warnings']:print('REVIEW:',w)
    except Exception as exc:
        print(f'ERROR: {exc}',file=sys.stderr);raise SystemExit(1)

if __name__=='__main__':main()
