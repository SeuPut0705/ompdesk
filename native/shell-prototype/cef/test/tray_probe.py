# python test/tray_probe.py <exe> [Show|Quit|icon] : drives the tray with window messages only (no SendInput, cursor untouched).
import ctypes, ctypes.wintypes as w, subprocess, sys, time
ctypes.windll.shcore.SetProcessDpiAwareness(2)
u=ctypes.windll.user32
name=sys.argv[1].lower(); what=sys.argv[2] if len(sys.argv)>2 else 'icon'
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
tray=find('tray_icon_app')[0]
WM_USER_TRAYICON=6002; WM_LBUTTONUP=0x202; WM_RBUTTONUP=0x205
if what=='icon':
    u.PostMessageW(tray,WM_USER_TRAYICON,0,WM_LBUTTONUP); print('posted tray left click')
else:
    u.PostMessageW(tray,WM_USER_TRAYICON,0,WM_RBUTTONUP); time.sleep(2.0)
    menus=find('#32768')
    print('menu windows',[hex(m) for m in menus])
    if menus:
        downs=1 if what=='Show' else 2
        for _ in range(downs):
            u.PostMessageW(menus[0],0x100,0x28,0); time.sleep(0.15)   # VK_DOWN
        u.PostMessageW(menus[0],0x100,0x0D,0)                            # VK_RETURN
        print('posted keys for',what)
