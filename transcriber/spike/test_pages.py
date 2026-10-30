# The pages tucked into a call (loggie-pause-attach I2 + I3): pages.py reads text, Markdown, PowerPoint and Word, gives ''
# for a file it cannot read, keeps the order they were tucked in and caps them at 6,000 words; privacy.screen_pages sends
# them as "Page N", never by file name, screened like the notes; the notes prompt with no pages is byte for byte the one
# before, and with approved pages carries a <pages> block; a changed page refuses; a page's terms join the user's own
# words; materials() never exits. Temp folders only, made-up people (fixtures).
#   python3 test_pages.py   (exit 0 = pass)
import contextlib, hashlib, io, json, os, subprocess, tempfile, time, zipfile
from pathlib import Path
import byo, pages, privacy, spelling, transcript
from test_byo import EVENT, folder_in

def pptx(path, slides):
    with zipfile.ZipFile(path, 'w') as z:
        for i, runs in enumerate(slides, 1):
            body = ''.join(f'<a:p><a:r><a:t>{r}</a:t></a:r></a:p>' for r in runs)
            z.writestr(f'ppt/slides/slide{i}.xml', f'<p:sld xmlns:a="a" xmlns:p="p"><p:cSld><p:spTree>{body}</p:spTree></p:cSld></p:sld>')

def test_reads_each_kind_and_never_fails():
    with tempfile.TemporaryDirectory() as d:
        d = Path(d)
        (d / 'a.txt').write_text('Corning glass case, Gorilla Glass margins.')
        (d / 'b.md').write_text('# Agenda\n\nDot-com bubble, 1999 to 2001.')
        pptx(d / 'c.pptx', [['Slide one', 'Fiber &amp; optics'], ['Slide two']] + [[f'Extra {n}'] for n in range(3, 12)])
        assert pages.text_of(d / 'a.txt').startswith('Corning') and 'Dot-com' in pages.text_of(d / 'b.md')
        text = pages.text_of(d / 'c.pptx')
        assert text.startswith('Slide one Fiber & optics\n\nSlide two') and text.index('Extra 10') > text.index('Extra 9'), 'slides in number order'
        subprocess.run(['textutil', '-convert', 'docx', str(d / 'a.txt'), '-output', str(d / 'd.docx')], check=True)
        assert 'Gorilla Glass' in pages.text_of(d / 'd.docx')
        (d / 'e.pdf').write_text('not a pdf'); (d / 'f.pptx').write_text('not a zip')
        with contextlib.redirect_stderr(io.StringIO()) as said:
            assert pages.text_of(d / 'e.pdf') == '' and pages.text_of(d / 'f.pptx') == ''
        assert 'could not be read' in said.getvalue()

def xlsx(path):
    # a made-up workbook: shared strings (one with two rich-text runs), an inline string, numbers, two sheets in order
    ns = 'xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"'
    with zipfile.ZipFile(path, 'w') as z:
        z.writestr('xl/workbook.xml', f'<workbook {ns}><sheets><sheet name="Exhibit 3" sheetId="1"/><sheet name="Margins" sheetId="2"/></sheets></workbook>')
        z.writestr('xl/sharedStrings.xml', f'<sst {ns}><si><t>Revenue</t></si><si><r><t>Gorilla </t></r><r><t>Glass</t></r></si></sst>')
        z.writestr('xl/worksheets/sheet1.xml', f'<worksheet {ns}><sheetData><row r="1"><c r="A1" t="s"><v>0</v></c><c r="B1"><v>4.2</v></c></row>'
                   f'<row r="2"><c r="A2" t="s"><v>1</v></c><c r="B2" t="inlineStr"><is><t>Corning</t></is></c><c r="C2"/></row></sheetData></worksheet>')
        z.writestr('xl/worksheets/sheet2.xml', f'<worksheet {ns}><sheetData><row r="1"><c r="A1"><v>0.38</v></c></row></sheetData></worksheet>')

def test_a_workbook_reads_as_sheets_of_rows():
    with tempfile.TemporaryDirectory() as d:
        xlsx(Path(d) / 'case.xlsx')
        assert pages.text_of(Path(d) / 'case.xlsx') == 'Sheet Exhibit 3\nRevenue | 4.2\nGorilla Glass | Corning\n\nSheet Margins\n0.38'

def test_order_and_cap():
    with tempfile.TemporaryDirectory() as d:
        p = Path(d) / 'pages'; p.mkdir()
        (p / 'z-first.txt').write_text('one two three'); os.utime(p / 'z-first.txt', (1, 1))
        (p / 'a-second.md').write_text('four\nfive  six\tseven')
        (p / 'skip.png').write_bytes(b'\x89PNG')
        found = pages.pages_of(d)
        assert [n for n, _ in found] == ['z-first.txt', 'a-second.md'], found
        assert pages.capped(found, 5) == [('z-first.txt', 'one two three'), ('a-second.md', 'four\nfive')]
        assert pages.capped(found, 3) == [('z-first.txt', 'one two three')]
        assert pages.pages_of(Path(d) / 'none') == []

def call_with_page(d, text, name='Lena Okafor offer letter.txt'):
    folder = folder_in(d)
    (folder / 'pages').mkdir()
    (folder / 'pages' / name).write_text(text)
    return folder

def test_screened_as_page_n_never_by_file_name():
    with tempfile.TemporaryDirectory() as d:
        folder = call_with_page(d, 'Agenda for the Acme Bank analyst role.\n\nCompensation bands and the start date.')
        out, held = privacy.screen_pages(folder)
        sent = out.read_text()
        assert 'Okafor' not in sent and 'offer letter' not in sent, 'a file name can name a person'
        assert [w for w, _ in privacy.pages_lines(sent)] == ['Page 1', 'Page 1']
        assert json.loads(held.read_text())['pages'] == ['Lena Okafor offer letter.txt'] and json.loads(held.read_text())['source'] == 'pages'
        assert privacy.pages_pair(folder) == (out, held) and privacy.screen_pages(folder) == (out, held), 'fresh until a page changes'
        time.sleep(0.02); (folder / 'pages' / 'more.md').write_text('A second page.')
        assert privacy.pages_pair(folder) is None, 'a new page makes the pair stale'
        for f in (folder / 'pages').iterdir(): f.unlink()
        assert privacy.screen_pages(folder) is None and not (folder / privacy.PAGES_OUT).exists(), 'no pages, no pair'

def test_a_version_folder_reads_the_calls_pages():
    with tempfile.TemporaryDirectory() as d:
        folder = call_with_page(d, 'The glass case.')
        v2 = folder / 'v2-nvidia'; v2.mkdir()
        assert privacy.pages_home(v2) == folder.resolve()

def test_prompt_without_pages_is_unchanged_and_with_pages_carries_them():
    with tempfile.TemporaryDirectory() as d:
        folder = folder_in(d)
        lines = byo.read_md(folder / 'transcript.md')
        before = byo.build_prompt(EVENT, lines, folder)
        assert byo.build_prompt(EVENT, lines, folder, pages=()) == before and '<pages>' not in before
        with_pages = byo.build_prompt(EVENT, lines, folder, pages=[('Page 1', 'Gorilla Glass margins.')])
        assert '<pages>' in with_pages and 'Page 1: Gorilla Glass margins.' in with_pages and 'what was said comes from the transcript only' in with_pages
        assert with_pages.replace(with_pages[with_pages.index('\n<pages>'):with_pages.index('</pages>\n') + 9], '') == before

def test_approved_pages_need_the_same_bytes():
    with tempfile.TemporaryDirectory() as d:
        folder = call_with_page(d, 'Corning glass case.')
        out, _ = privacy.screen_pages(folder)
        sha = hashlib.sha256(out.read_bytes()).hexdigest()
        assert byo.approved_pages_of(folder, None) == []
        assert byo.approved_pages_of(folder, sha) == [('Page 1', 'Corning glass case.')]
        out.write_text(out.read_text() + '\n[00:00] Page 2: added later\n')
        with contextlib.redirect_stderr(io.StringIO()) as said:
            try: byo.approved_pages_of(folder, sha); raise AssertionError('no refusal')
            except SystemExit as e: assert e.code == 2
        assert 'changed since you reviewed them' in said.getvalue()

def test_a_page_with_no_yes_is_refused_out_loud():
    # loggie-pages-anytime: a page tucked in after the send was screened has no hash; byo.py refuses, never leaves it out.
    with tempfile.TemporaryDirectory() as d:
        folder = call_with_page(d, 'Corning glass case.')
        assert byo.unscreened_pages(folder)
        (folder / 'pages' / 'Lena Okafor offer letter.txt').write_text('   ')
        assert not byo.unscreened_pages(folder), 'a page with no words is no page'

def test_a_pages_terms_join_the_users_own_words():
    with tempfile.TemporaryDirectory() as d:
        folder = call_with_page(d, 'Zorvex Holdings bought Quillara. Zorvex Holdings and Quillara again.', name='slides.txt')
        words = spelling.own_words(folder, EVENT)
        assert any(src == 'your page "slides.txt"' for _, src in words), words[-5:]

def test_materials_never_exits():
    with tempfile.TemporaryDirectory() as d:
        with contextlib.redirect_stderr(io.StringIO()) as said:
            assert transcript.materials(Path(d)) == []
        assert 'no readable materials' in said.getvalue()

if __name__ == '__main__':
    for name, fn in list(globals().items()):
        if name.startswith('test_'): fn(); print('ok', name)
