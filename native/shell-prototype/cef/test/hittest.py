# python test/hittest.py <exe-name-substring>  : sends WM_NCHITTEST to the top-level window of the running shell (no input synthesis).
import ctypes, ctypes.wintypes as w, sys, subprocess, json
ctypes.windll.shcore.SetProcessDpiAwareness(2)
u=ctypes.windll.user32
name=(sys.argv[1] if len(sys.argv)>1 else 'shell-cef').lower()
out=subprocess.run(['tasklist','/FO','CSV','/NH'],capture_output=True,text=True).stdout
pids={int(l.split('","')[1]) for l in out.splitlines() if name in l.lower()}
res=[]
@ctypes.WINFUNCTYPE(w.BOOL,w.HWND,w.LPARAM)
def cb(h,l):
    pid=w.DWORD(); u.GetWindowThreadProcessId(h,ctypes.byref(pid))
    if pid.value in pids and u.IsWindowVisible(h) and not u.GetParent(h):
        buf=ctypes.create_unicode_buffer(256); u.GetWindowTextW(h,buf,256)
        cls=ctypes.create_unicode_buffer(128); u.GetClassNameW(h,cls,128)
        r=w.RECT(); u.GetWindowRect(h,ctypes.byref(r))
        res.append((h,buf.value,cls.value,r.left,r.top,r.right,r.bottom))
    return True
u.EnumWindows(cb,0)
names={0:'HTNOWHERE',1:'HTCLIENT',2:'HTCAPTION',8:'HTMINBUTTON',9:'HTMAXBUTTON',20:'HTCLOSE',10:'HTLEFT',11:'HTRIGHT',12:'HTTOP',15:'HTBOTTOM',-1:'HTERROR'}
for h,t,c,l,tp,r,b in res:
    print('window',hex(h),repr(t),c,(l,tp,r,b))
    W=r-l
    pts={'top bar x=300 DIP,y=20 DIP':(l+375,tp+25),'top bar centre':(l+W//2,tp+25),'top bar x=W-250px':(l+W-250,tp+25),'caption area min (W-143,30)':(l+W-143,tp+30),'caption area max (W-86,30)':(l+W-86,tp+30),'caption area close (W-29,30)':(l+W-29,tp+30),'body (375,375)':(l+375,tp+375),'left edge (2,375)':(l+2,tp+375),'top edge (375,1)':(l+375,tp+1)}
    for k,(x,y) in pts.items():
        lp=((y&0xFFFF)<<16)|(x&0xFFFF)
        r_=u.SendMessageW(h,0x84,0,lp)
        print(f'  {k}: screen ({x},{y}) -> {r_} {names.get(r_,"?")}')
