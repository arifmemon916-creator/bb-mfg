#!/bin/bash
cd "$(dirname "$0")"

if ! command -v node >/dev/null 2>&1; then
  echo "Node.js nahi mila. Pehle https://nodejs.org se Node.js (LTS) install karo, phir is file ko dobara chalao."
  read -p "Press Enter to exit..."
  exit 1
fi

if [ ! -d node_modules ]; then
  echo "Dependencies install ho rahi hain, thoda wait karo..."
  npm install
fi

echo ""
echo "BizBill server start ho raha hai..."
echo "Browser me automatically khulega: http://127.0.0.1:8080/"
echo "Is terminal window ko band mat karo jab tak app use kar rahe ho."
echo ""

( sleep 1 && (open http://127.0.0.1:8080/ 2>/dev/null || xdg-open http://127.0.0.1:8080/ 2>/dev/null) ) &
node tools/serve.mjs
