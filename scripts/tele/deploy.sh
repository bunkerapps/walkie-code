#!/bin/sh
# Copia el puente a la tele al teléfono por SSH (Termux escucha en el 8022).
#   scripts/tele/deploy.sh usuario@ip [puerto]
# En el teléfono, ~/walkie-tele/run.sh define TELE_TOKEN, TELE_DEVICE y TELE_CATT y corre tele.py.
set -e
cd "$(dirname "$0")"
destino=${1:?usuario@ip del teléfono}
puerto=${2:-8022}
ssh -p "$puerto" "$destino" 'mkdir -p ~/walkie-tele'
scp -P "$puerto" tele.py "$destino:walkie-tele/"
