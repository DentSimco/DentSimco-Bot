#!/bin/bash
# DentSimco borsa (SimcoTools) toplayıcı: VPS'te her 5 dakikada bir bot/market.mjs çalıştırır.
# GitHub'daki borsa.yml'in yerini alır; ikisini aynı anda açık bırakmayın (çift yazım).
# Tur, başlangıçtan başlangıca 300 sn olacak şekilde ayarlanır; tur uzarsa sonraki hemen başlar.
cd /opt/dentsimco/bot-repo || exit 1
export FIREBASE_SERVICE_ACCOUNT_JSON="$(cat /etc/dentsimco/firebase.json)"
while true; do
  start=$(date +%s)
  /usr/bin/node bot/market.mjs || echo "market.mjs hata kodu $?"
  elapsed=$(( $(date +%s) - start ))
  if [ "$elapsed" -lt 300 ]; then sleep $(( 300 - elapsed )); fi
done
