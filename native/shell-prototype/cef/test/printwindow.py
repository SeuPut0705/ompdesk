# python test/printwindow.py <exe-substring> <out.png> : PrintWindow(PW_RENDERFULLCONTENT) of the process's top-level window, DPI aware.
import ctypes, ctypes.wintypes as w, sys, subprocess
ctypes.windll.shcore.SetProcessDpiAwareness(2)
u=ctypes.windll.user32; g=ctypes.windll.gdi32
name=sys.argv[1].lower(); outp=sys.argv[2]
out=subprocess.run(['tasklist','/FO','CSV','/NH'],capture_output=True,text=True).stdout
pids={int(l.split('","')[1]) for l in out.splitlines() if name in l.lower()}
wins=[]
@ctypes.WINFUNCTYPE(w.BOOL,w.HWND,w.LPARAM)
def cb(h,l):
    pid=w.DWORD(); u.GetWindowThreadProcessId(h,ctypes.byref(pid))
    if pid.value in pids and u.IsWindowVisible(h) and not u.GetParent(h):
        r=w.RECT(); u.GetWindowRect(h,ctypes.byref(r)); wins.append((h,r))
    return True
u.EnumWindows(cb,0)
h,r=wins[0]; W,H=r.right-r.left,r.bottom-r.top
dc=u.GetDC(0); mdc=g.CreateCompatibleDC(dc); bmp=g.CreateCompatibleBitmap(dc,W,H); g.SelectObject(mdc,bmp)
ok=u.PrintWindow(h,mdc,2)
class BMI(ctypes.Structure): _fields_=[('s',w.DWORD),('w',w.LONG),('h',w.LONG),('p',w.WORD),('b',w.WORD),('c',w.DWORD),('i',w.DWORD),('x',w.LONG),('y',w.LONG),('u',w.DWORD),('v',w.DWORD)]
bi=BMI(40,W,-H,1,32,0,0,0,0,0,0)
buf=ctypes.create_string_buffer(W*H*4); g.GetDIBits(mdc,bmp,0,H,buf,ctypes.byref(bi),0)
from PIL import Image
Image.frombuffer('RGBA',(W,H),buf,'raw','BGRA',0,1).convert('RGB').save(outp); print('printwindow',ok,W,H)
