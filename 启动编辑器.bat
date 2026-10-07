@echo off
rem ---------------------------------------------------------------------------
rem  Zhulu raster map editor -- launcher
rem
rem  This file is deliberately ASCII-only. After "chcp 65001" takes effect,
rem  cmd.exe re-reads a batch file with a byte offset that desyncs on
rem  multi-byte characters, which shreds the following lines (observed: "if" and
rem  "echo" split into garbage plus a pile of "not recognized as an internal or
rem  external command"). So every Chinese message is printed by serve.py, which
rem  sets its own stdout to UTF-8.
rem
rem  Line endings must stay CRLF -- do not save this file as LF.
rem ---------------------------------------------------------------------------
chcp 65001 >nul
cd /d "%~dp0"

set "PY="
py -3 -c "import sys" >nul 2>nul && set "PY=py -3"
if not defined PY (
  python -c "import sys" >nul 2>nul && set "PY=python"
)
if not defined PY goto nopython

rem serve.py picks the port itself: 8770 by default, next free one if taken
%PY% serve.py %*
if errorlevel 1 goto failed
exit /b 0

:failed
echo.
echo   [ERROR] serve.py exited with a non-zero code -- read its message above,
echo           then check the port it reported. Running this launcher again is
echo           safe: it picks the next free port by itself.
echo   (press any key to close this window)
pause >nul
exit /b 1

:nopython
echo.
echo   [ERROR] Python 3 not found: neither "py -3" nor "python" could run.
echo   Install Python 3 from python.org, tick "Add python.exe to PATH",
echo   then double-click this file again.
echo.
echo   There is only ONE build: this module version, served by serve.py --
echo   Python 3 is required; the single-file fallback has been removed.
echo   (press any key to close this window)
pause >nul
exit /b 1
