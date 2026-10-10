# Tune themes in src/styles.css to the app's contrast rules, keeping each colour's hue (only lightness moves;
# greys lose their tint). Usage: python3 scripts/tune-themes.py src/styles.css [themes,to,skip]
# e.g.  python3 scripts/tune-themes.py src/styles.css light,dark   (the classic two keep their system blue/red)
# The same rules are checked by src/lib/theme.test.ts.
import re, sys, colorsys
path=sys.argv[1]; skip=set(sys.argv[2].split(',')) if len(sys.argv)>2 else set()
css=open(path).read()
def rgb(h): h=h.strip().lstrip('#'); return tuple(int(h[i:i+2],16)/255 for i in (0,2,4))
def hexc(c): return '#'+''.join(f'{max(0,min(255,round(u*255))):02x}' for u in c)
def lum(c):
    f=lambda u: u/12.92 if u<=0.04045 else ((u+0.055)/1.055)**2.4
    r,g,b=map(f,c); return 0.2126*r+0.7152*g+0.0722*b
def cr(a,b):
    la,lb=lum(a),lum(b); hi,lo=max(la,lb),min(la,lb); return (hi+0.05)/(lo+0.05)
def hls(h): return colorsys.rgb_to_hls(*rgb(h))
def from_hls(h,l,s): return colorsys.hls_to_rgb(h,max(0,min(1,l)),max(0,min(1,s)))
def chroma(c): h,l,s=colorsys.rgb_to_hls(*c); return s*min(l,1-l)*2
def cap_chroma(c,cap):
    h,l,s=colorsys.rgb_to_hls(*c)
    while chroma(from_hls(h,l,s))>cap and s>0: s-=0.01
    return from_hls(h,l,s)
def push(c, against, target, dark_bg, minimum=True):
    """Move lightness away from the background until contrast ≥ target (or down to ≈ target if minimum=False)."""
    h,l,s=colorsys.rgb_to_hls(*c); step=0.004 if dark_bg else -0.004
    cur=from_hls(h,l,s)
    if minimum:
        n=0
        while min(cr(cur,a) for a in against)<target and n<400: l+=step; cur=from_hls(h,l,s); n+=1
    else:  # aim for ≈ target from either side
        n=0
        while cr(cur,against[0])>target+0.15 and n<400: l-=step; cur=from_hls(h,l,s); n+=1
        while cr(cur,against[0])<target and n<400: l+=step; cur=from_hls(h,l,s); n+=1
    return cur
def tune(v):
    bg=rgb(v['bg']); panel=rgb(v['panel']); dark=lum(bg)<0.2
    out={}
    out['text']=push(cap_chroma(rgb(v['text']),0.03),[bg,panel],15,dark)
    out['text-2']=push(cap_chroma(rgb(v['text-2']),0.05),[bg,panel],6,dark)
    out['text-3']=push(cap_chroma(rgb(v['text-3']),0.05),[bg],3.0,dark,minimum=False)
    out['line']=cap_chroma(rgb(v['line']),0.06)
    out['line-soft']=cap_chroma(rgb(v['line-soft']),0.06)
    for k in ('accent','focus'):
        out[k]=push(rgb(v[k]),[bg,panel],5.0,dark)
    for k,on in (('accent','on-accent'),('focus','on-focus')):
        a=out[k]; white=(1,1,1); ink=rgb(v[on]) if lum(rgb(v[on]))<0.2 else (0.06,0.06,0.07)
        out[on]=white if cr(a,white)>=cr(a,ink) else ink
    return {k:hexc(c) for k,c in out.items()}
changed=[]
def repl(m):
    name=m.group(1); body=m.group(2)
    if name in skip: return m.group(0)
    v=dict(re.findall(r"--([\w-]+):\s*(#[0-9a-fA-F]{6});", body))
    t=tune(v)
    for k,new in t.items():
        if k in v and v[k].lower()!=new.lower():
            body=re.sub(rf"(--{k}:\s*)#[0-9a-fA-F]{{6}};", rf"\g<1>{new};", body); changed.append((name,k,v[k],new))
    return m.group(0).replace(m.group(2), body)
css=re.sub(r":root(?:, :root)?\[data-theme='(\w+)'\][^{]*\{([^}]*)\}", repl, css)
open(path,'w').write(css)
for c in changed: print(*c)
