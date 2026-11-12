# python test/winprobe.py <exe> : lists every window of the process (top-level incl. hidden / message-only classes) and runs the caption + tray probes with window messages only.
import ctypes, ctypes.wintypes as w, subprocess, sys, time, json
ctypes.windll.shcore.SetProcessDpiAwareness(2)
u=ctypes.windll.user32
name=sys.argv[1].lower()
out=subprocess.run(['tasklist','/FO','CSV','/NH'],capture_output=True,text=True).stdout
pids={int(l.split('","')[1]) for l in out.splitlines() if name in l.lower()}
res=[]
@ctypes.WINFUNCTYPE(w.BOOL,w.HWND,w.LPARAM)
def cb(h,l):
    pid=w.DWORD(); u.GetWindowThreadProcessId(h,ctypes.byref(pid))
    if pid.value in pids:
        cls=ctypes.create_unicode_buffer(128); u.GetClassNameW(h,cls,128)
        r=w.RECT(); u.GetWindowRect(h,ctypes.byref(r))
        res.append((h,cls.value,bool(u.IsWindowVisible(h)),(r.left,r.top,r.right,r.bottom)))
    return True
u.EnumWindows(cb,0)
# message-only windows are not enumerated by EnumWindows: find by class
for cls in ('tray_icon_app','tao_tray','MuDa Menu Window'):
    pass
for h,c,v,r in res: print(hex(h),c,v,r)
