"""Local, deterministic QA/voice preview cards. Requires Pillow; no AI or browser calls."""
from pathlib import Path
import json, os, textwrap
from PIL import Image, ImageDraw, ImageFont
ROOT = Path(__file__).resolve().parents[1]
FONT = os.environ.get('LANDING_MEDIA_FONT', '/System/Library/Fonts/Supplemental/Arial Bold.ttf')
for locale in ('uk', 'ru', 'en'):
    strings = json.loads((ROOT / f'src/dictionaries/{locale}.json').read_text())
    for product in ('qa', 'hands-free'):
        voice = product == 'hands-free'
        accent = '#98b9ff' if voice else '#62ddd0'
        image = Image.new('RGB', (1200, 630), '#0c1423')
        draw = ImageDraw.Draw(image)
        draw.rectangle((0, 0, 1200, 14), fill=accent)
        def text(x, y, value, size, color='#f4f7ff'):
            draw.text((x, y), value, font=ImageFont.truetype(FONT, size), fill=color)
        text(64, 55, 'Viral4Creators', 32)
        text(64, 118, 'HANDS-FREE' if voice else 'WEBSITE QA', 22, accent)
        title = strings['og'][product]
        lines = textwrap.wrap(title, width=23)
        size = 54
        for line in lines:
            while draw.textbbox((0, 0), line, font=ImageFont.truetype(FONT, size))[2] > 740:
                size -= 1
        for i, line in enumerate(lines):
            text(64, 195 + i * 68, line, size)
        draw.rounded_rectangle((870, 164, 1130, 450), radius=22, fill='#172840', outline=accent, width=2)
        if voice:
            for i, h in enumerate((30, 70, 115, 165, 100, 145, 65, 30)):
                x = 900 + i * 26
                draw.rounded_rectangle((x, 300-h//2, x+12, 300+h//2), radius=6, fill=accent)
        else:
            for i in range(3):
                y = 210 + i * 68
                draw.rounded_rectangle((899, y, 928, y+29), radius=6, outline=accent, width=3)
                draw.line((905, y+15, 912, y+22, 924, y+7), fill=accent, width=3)
                draw.line((948, y+14, 1095, y+14), fill='#d3deef', width=7)
        text(64, 510, strings['og']['handsFreeBadge'] if voice else strings['og']['qaBadge'], 24, accent)
        text(64, 561, f'viral4creators.app / {locale.upper()}', 21, '#aebdd3')
        out = ROOT / 'public/og' / f'{product}-{locale}.jpg'
        image.save(out, quality=90, optimize=True)
        print(out.name)
