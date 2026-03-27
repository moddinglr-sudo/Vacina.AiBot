@echo off
title VaccinaBot Server

echo.
echo  ╔══════════════════════════════════════════╗
echo  ║         VaccinaBot — Iniciando...        ║
echo  ╚══════════════════════════════════════════╝
echo.

:: Instala dependencias se node_modules nao existir
if not exist "node_modules" (
  echo  [1/2] Instalando dependencias...
  npm install
  echo.
)

:: Inicia o servidor
echo  [2/2] Iniciando servidor...
echo  Acesse: http://localhost:3000
echo  Deixe esta janela aberta!
echo.

node server.js

pause
