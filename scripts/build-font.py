# Build TTF (glyf) from the same contour data, then derive WOFF/WOFF2.
import numpy as np
from PIL import Image
from skimage import measure
from fontTools.fontBuilder import FontBuilder
from fontTools.pens.ttGlyphPen import TTGlyphPen
from fontTools.ttLib import TTFont

A=np.asarray(Image.open("sheet.png").convert("RGB")).astype(int)
bg=A[0,0]; INK=(np.sqrt(((A-bg)**2).sum(2))>60)
ROWS=[(312,398,list("ABCDEFGHIJKLM")),(456,544,list("NOPQRSTUVWXYZ")),
 (591,713,list("abcdefghijklm")),(736,849,list("nopqrstuvwxyz")),
 (857,970,["AE","Oslash","Aring","ae","oslash","aring"]),(1016,1106,list("0123456789")),
 (1150,1233,["period","comma","colon","semicolon","exclam","question","quotesingle","quotedbl","parenleft","parenright","bracketleft","bracketright","braceleft","braceright"]),
 (1259,1354,["slash","backslash","hyphen","underscore","plus","equal","asterisk","ampersand","percent","numbersign","at","dollar"]),
 (1375,1448,["Euro","less","greater","bar","asciicircum","asciitilde"])]
UNI={"AE":0xC6,"Oslash":0xD8,"Aring":0xC5,"ae":0xE6,"oslash":0xF8,"aring":0xE5,"period":0x2E,"comma":0x2C,"colon":0x3A,"semicolon":0x3B,"exclam":0x21,"question":0x3F,"quotesingle":0x27,"quotedbl":0x22,"parenleft":0x28,"parenright":0x29,"bracketleft":0x5B,"bracketright":0x5D,"braceleft":0x7B,"braceright":0x7D,"slash":0x2F,"backslash":0x5C,"hyphen":0x2D,"underscore":0x5F,"plus":0x2B,"equal":0x3D,"asterisk":0x2A,"ampersand":0x26,"percent":0x25,"numbersign":0x23,"at":0x40,"dollar":0x24,"Euro":0x20AC,"less":0x3C,"greater":0x3E,"bar":0x7C,"asciicircum":0x5E,"asciitilde":0x7E}
def segs_of(col,n):
    s=[];inc=False
    for x,v in enumerate(col>0):
        if v and not inc: st=x;inc=True
        if not v and inc: s.append([st,x]);inc=False
    if inc: s.append([st,len(col)])
    s=[a for a in s if a[1]-a[0]>=2] or s
    while len(s)>n:
        i=min(range(len(s)-1),key=lambda i:s[i+1][0]-s[i][1]); s[i][1]=s[i+1][1]; del s[i+1]
    return s
def ybb(x0,x1,y0,y1):
    sub=INK[y0:y1,x0:x1]; ys=np.where(sub.any(1))[0]; xs=np.where(sub.any(0))[0]
    if len(ys)==0: return None
    return x0+xs[0],x0+xs[-1]+1,y0+ys[0],y0+ys[-1]+1
# cap scale
su=segs_of(INK[312:398].sum(0),13); bots=[];tops=[]
for s in su:
    bb=ybb(s[0],s[1],312,398)
    if bb: tops.append(bb[2]); bots.append(bb[3])
baseU=int(np.percentile(bots,80)); scale=700.0/(baseU-int(min(tops))); LSB=45
order=[".notdef"]; cmap={}; glyf={}; metrics={}
pen=TTGlyphPen(None); metrics[".notdef"]=(320,0); glyf[".notdef"]=pen.glyph()
def add(name,mask,ix0,iy0,base):
    h,w=mask.shape; pad=np.zeros((h+2,w+2),bool); pad[1:-1,1:-1]=mask
    adv=int(round(w*scale))+2*LSB; pen=TTGlyphPen(None); drew=False
    for cnt in measure.find_contours(pad.astype(float),0.5):
        cnt=measure.approximate_polygon(cnt,tolerance=1.1)
        if len(cnt)<3: continue
        pts=[]
        for r,c in cnt[:-1]:
            pts.append((LSB+(c-1)*scale,(base-(iy0+(r-1)))*scale))
        pen.moveTo(pts[0])
        for p in pts[1:]: pen.lineTo(p)
        pen.closePath(); drew=True
    glyf[name]=pen.glyph(); metrics[name]=(adv,LSB); order.append(name)
    if len(name)==1: cmap[ord(name)]=name
    elif name in UNI: cmap[UNI[name]]=name
for y0,y1,chars in ROWS:
    s=segs_of(INK[y0:y1].sum(0),len(chars)); bbs=[ybb(a[0],a[1],y0,y1) for a in s]
    base=int(np.percentile([b[3] for b in bbs if b],80))
    for a,name,bb in zip(s,chars,bbs):
        if bb: add(name,INK[bb[2]:bb[3],bb[0]:bb[1]],bb[0],bb[2],base)
pen=TTGlyphPen(None); glyf["space"]=pen.glyph(); metrics["space"]=(320,0); order.append("space"); cmap[0x20]="space"
fb=FontBuilder(1000,isTTF=True)
fb.setupGlyphOrder(order); fb.setupCharacterMap(cmap); fb.setupGlyf(glyf)
fb.setupHorizontalMetrics(metrics); fb.setupHorizontalHeader(ascent=800,descent=-200)
fb.setupNameTable({"familyName":"kl.oss.ete","styleName":"Regular","fullName":"kl.oss.ete Regular","psName":"KlOssEte-Regular","version":"1.0","manufacturer":"kl.oss.ete"})
fb.setupOS2(sTypoAscender=800,sTypoDescender=-200,usWinAscent=900,usWinDescent=250,sCapHeight=700,sxHeight=480)
fb.setupPost()
fb.save("KlOssEte-Regular.ttf")
for flavor,ext in [("woff2","woff2"),("woff","woff")]:
    f=TTFont("KlOssEte-Regular.ttf"); f.flavor=flavor; f.save(f"KlOssEte-Regular.{ext}")
print("built TTF/WOFF/WOFF2, glyphs:",len(order))
