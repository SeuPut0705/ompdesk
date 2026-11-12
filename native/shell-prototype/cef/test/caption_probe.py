# python test/caption_probe.py <exe> : posts WM_LBUTTONUP to the caption window (min/max/close zones) - window messages only.
import ctypes, ctypes.wintypes as w, subprocess, sys, time
ctypes.windll.shcore.SetProcessDpiAwareness(2)
u=ctypes.windll.user32
name=sys.argv[1].lower()
out=subprocess.run(['tasklist','/FO','CSV','/NH'],capture_output=True,text=True).stdout
pids={int(l.split('","')[1]) for l in out.splitlines() if name in l.lower()}
def find(cls):
    r=[]
    @ctypes.WINFUNCTYPE(w.BOOL,w.HWND,w.LPARAM)
    def cb(h,l):
        pid=w.DWORD(); u.GetWindowThreadProcessId(h,ctypes.byref(pid))
        c=ctypes.create_unicode_buffer(128); u.GetClassNameW(h,c,128)
        if pid.value in pids and c.value==cls: r.append(h)
        return True
    u.EnumWindows(cb,0); return r
cap=find('OmpProtoCaption')[0]; top=find('Chrome_WidgetWin_1')
top=[t for t in top if u.IsWindowVisible(t)][0]
r=w.RECT(); u.GetClientRect(cap,ctypes.byref(r)); W=r.right
def click(z): u.PostMessageW(cap,0x202,0,(10<<16)|(int(W*(z+0.5)/3)))
print('caption client width',W,'zoomed before',u.IsZoomed(top))
click(1); time.sleep(1.0); print('after max click: zoomed',u.IsZoomed(top))
click(1); time.sleep(1.0); print('after 2nd max click: zoomed',u.IsZoomed(top))
click(0); time.sleep(1.0); print('after min click: iconic',u.IsIconic(top),'caption visible',u.IsWindowVisible(cap))
u.ShowWindow(top,9); time.sleep(0.8); print('restored: iconic',u.IsIconic(top),'caption visible',u.IsWindowVisible(cap))
if len(sys.argv)>2 and sys.argv[2]=='close':
    click(2); time.sleep(3); print('after close click: window alive',bool(u.IsWindow(top)))
