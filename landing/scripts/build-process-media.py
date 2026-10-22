# Local process illustrations only. Requires Pillow and ffmpeg; never calls a provider.
from pathlib import Path
import subprocess,os
root=Path(__file__).resolve().parents[2]
font=os.environ.get('LANDING_MEDIA_FONT', '/System/Library/Fonts/Supplemental/Arial Bold.ttf')
labels={
'ru':{'ads':['Продукт','Сюжет','Короткий ролик'],'greetings':['Повод','Личное пожелание','Видеопоздравление'],'stories':['Библиотека сказок','Рассказчик и голос','Просмотр и проверка'],'qa':['Выберите сценарий','Проверьте результат','Замечания и отчёт']},
'uk':{'ads':['Продукт','Сюжет','Короткий ролик'],'greetings':['Привід','Особисте побажання','Відеопривітання'],'stories':['Бібліотека казок','Оповідач і голос','Перегляд і перевірка'],'qa':['Оберіть сценарій','Перевірте результат','Зауваження та звіт']},
'en':{'ads':['Your product','Your story','A short video'],'greetings':['The occasion','A personal message','A video greeting'],'stories':['Story library','Narrator and voice','Review the result'],'qa':['Choose a workflow','Check the result','Findings and report']},
'de':{'ads':['Ihr Produkt','Ihre Geschichte','Ein kurzes Video'],'greetings':['Der Anlass','Eine persönliche Nachricht','Ein Videogruß'],'stories':['Märchenbibliothek','Erzähler und Stimme','Ergebnis prüfen']},
'es':{'ads':['Tu producto','Tu historia','Un vídeo corto'],'greetings':['La ocasión','Un mensaje personal','Un saludo en vídeo'],'stories':['Biblioteca de cuentos','Narrador y voz','Revisar el resultado']}}
for locale,steps in {'ru':['Одна задача','Запись экрана','Проверка результата'],'uk':['Одне завдання','Запис екрана','Перевірка результату'],'en':['One task','Screen recording','Check the result'],'de':['Eine Aufgabe','Bildschirmaufnahme','Ergebnis prüfen'],'es':['Una tarea','Grabar la pantalla','Revisar el resultado']}.items():labels[locale]['tutorial']=steps
labels['uk']['publisher']=['Завдання','Редакторська перевірка','Публікація']
for locale,products in labels.items():
 for product,steps in products.items():
  app='publisher-site' if product=='publisher' else 'sites-landing' if product=='qa' else 'landing';out=root/app/'public/media';out.mkdir(parents=True,exist_ok=True)
  base=f'{product}-process-{locale}'
  from PIL import Image,ImageDraw,ImageFont
  temp=Path('/tmp/landing-media-slides')/base;temp.mkdir(parents=True,exist_ok=True)
  for i,text in enumerate(steps):
   image=Image.new('RGB',(960,540),'#101d38');draw=ImageDraw.Draw(image)
   draw.rounded_rectangle((38,38,922,502),radius=28,fill='#192e4c')
   draw.rectangle((60,65,900,73),fill='#63d5d0')
   draw.text((60,100),f'Viral4Creators / {product.upper()}',font=ImageFont.truetype(font,23),fill='white')
   draw.text((60,212),f'{i+1:02d}  {text}',font=ImageFont.truetype(font,38),fill='white')
   draw.rectangle((60,315,60+(i+1)*270,323),fill='#63d5d0')
   draw.text((60,445),'PROCESS CONCEPT / NO AUDIO',font=ImageFont.truetype(font,19),fill='#b9cce2')
   image.save(temp/f'{i}.png')
   if i==0:image.save(out/(base+'.jpg'),quality=85)
  manifest=temp/'frames.txt';manifest.write_text(''.join(f"file '{temp}/{i}.png'\nduration 4\n" for i in range(3))+f"file '{temp}/2.png'\n")
  subprocess.run(['ffmpeg','-hide_banner','-loglevel','error','-y','-f','concat','-safe','0','-i',str(manifest),'-t','12','-r','12','-c:v','libx264','-preset','veryfast','-crf','27','-pix_fmt','yuv420p','-movflags','+faststart','-an',str(out/(base+'.mp4'))],check=True)
print('local silent process clips generated; no provider calls')
