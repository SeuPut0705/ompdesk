# source this: CEF build env (cmake+ninja from VS Build Tools)
export CEF_PATH='X:\cef\cef-bin'
VS='C:\Program Files (x86)\Microsoft Visual Studio\2022\BuildTools\Common7\IDE\CommonExtensions\Microsoft\CMake'
export PATH="$PATH;$VS\CMake\bin;$VS\Ninja"
export CEF_DOWNLOAD_URL=http://127.0.0.1:8123
. "$(dirname "${BASH_SOURCE[0]}")/vcenv.sh"
