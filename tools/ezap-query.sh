#!/bin/bash
# =====================================================
# E-ZAP Terminal Query Tool (Termux / Linux)
# Consultas rapidas no Supabase via REST API
# =====================================================

BASE_URL="https://xsqpqdjffjqxdcmoytfc.supabase.co/rest/v1"
SERVICE_KEY="eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InhzcXBxZGpmZmpxeGRjbW95dGZjIiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImlhdCI6MTc2MzUxMjIwMywiZXhwIjoyMDc5MDg4MjAzfQ.QmSMnUA2x5AkhN_je20lcAb889-DnSyT-8w3dSQhsWM"

HEADERS=(-H "apikey: $SERVICE_KEY" -H "Authorization: Bearer $SERVICE_KEY" -H "Content-Type: application/json")

# Cores
GREEN='\033[0;32m'
CYAN='\033[0;36m'
YELLOW='\033[1;33m'
RED='\033[0;31m'
BOLD='\033[1m'
NC='\033[0m'

format_json() {
  python3 -m json.tool 2>/dev/null || cat
}

query() {
  curl -s "$BASE_URL/$1" "${HEADERS[@]}" | format_json
}

rpc() {
  curl -s "$BASE_URL/rpc/$1" -X POST "${HEADERS[@]}" -d "$2" | format_json
}

show_menu() {
  clear
  echo -e "${BOLD}${GREEN}"
  echo "  =============================="
  echo "   E-ZAP Query Tool"
  echo "  =============================="
  echo -e "${NC}"
  echo -e "  ${CYAN}USUARIOS${NC}"
  echo -e "  ${BOLD}1${NC} - Listar todos os usuarios"
  echo -e "  ${BOLD}2${NC} - Buscar usuario por nome"
  echo -e "  ${BOLD}3${NC} - Buscar usuario por email"
  echo -e "  ${BOLD}4${NC} - Usuarios ativos/inativos"
  echo ""
  echo -e "  ${CYAN}ATIVIDADE${NC}"
  echo -e "  ${BOLD}5${NC} - Atividade de um usuario (por nome)"
  echo -e "  ${BOLD}6${NC} - Eventos de mensagem (por nome)"
  echo -e "  ${BOLD}7${NC} - Resumo do time (hoje)"
  echo ""
  echo -e "  ${CYAN}CRM${NC}"
  echo -e "  ${BOLD}8${NC} - Abas de um usuario"
  echo -e "  ${BOLD}9${NC} - Labels de um usuario"
  echo -e "  ${BOLD}10${NC} - Observacoes de um usuario"
  echo -e "  ${BOLD}11${NC} - Sequencias de msg de um usuario"
  echo -e "  ${BOLD}12${NC} - Mensagens globais"
  echo ""
  echo -e "  ${CYAN}AVANCADO${NC}"
  echo -e "  ${BOLD}13${NC} - Query SQL livre (via RPC)"
  echo -e "  ${BOLD}14${NC} - Query REST livre"
  echo ""
  echo -e "  ${BOLD}0${NC} - Sair"
  echo ""
  echo -ne "  ${YELLOW}Escolha: ${NC}"
}

get_user_id() {
  local name="$1"
  curl -s "$BASE_URL/users?name=ilike.*${name}*&select=id" "${HEADERS[@]}" | python3 -c "
import sys, json
data = json.load(sys.stdin)
if data:
    print(data[0]['id'])
else:
    print('')
" 2>/dev/null
}

pause() {
  echo ""
  echo -ne "  ${YELLOW}[Enter para voltar]${NC}"
  read
}

# =====================================================
# OPCOES
# =====================================================

opt_list_users() {
  echo -e "\n  ${CYAN}Todos os usuarios:${NC}\n"
  query "users?select=id,name,email,phone,role,active,last_active&order=name.asc"
  pause
}

opt_search_name() {
  echo -ne "\n  ${YELLOW}Nome (ou parte): ${NC}"
  read name
  echo -e "\n  ${CYAN}Resultados para '$name':${NC}\n"
  query "users?name=ilike.*${name}*&select=id,name,email,phone,role,active,created_at,last_active"
  pause
}

opt_search_email() {
  echo -ne "\n  ${YELLOW}Email (ou parte): ${NC}"
  read email
  echo -e "\n  ${CYAN}Resultados para '$email':${NC}\n"
  query "users?email=ilike.*${email}*&select=id,name,email,phone,role,active,created_at,last_active"
  pause
}

opt_users_status() {
  echo -ne "\n  ${YELLOW}Filtrar por (1=ativos, 2=inativos, 3=todos): ${NC}"
  read status
  case $status in
    1) query "users?active=eq.true&select=name,email,role,last_active&order=name.asc" ;;
    2) query "users?active=eq.false&select=name,email,role,last_active&order=name.asc" ;;
    *) query "users?select=name,email,role,active,last_active&order=name.asc" ;;
  esac
  pause
}

opt_user_activity() {
  echo -ne "\n  ${YELLOW}Nome do usuario: ${NC}"
  read name
  local uid=$(get_user_id "$name")
  if [ -z "$uid" ]; then
    echo -e "  ${RED}Usuario nao encontrado${NC}"
    pause
    return
  fi
  echo -e "\n  ${CYAN}Atividade de '$name' (ultimos 7 dias):${NC}\n"
  query "user_activity?user_id=eq.${uid}&order=activity_date.desc&limit=7&select=activity_date,messages_sent,messages_received,unique_contacts,avg_response_time_seconds,sla_met_count,sla_missed_count"
  pause
}

opt_message_events() {
  echo -ne "\n  ${YELLOW}Nome do usuario: ${NC}"
  read name
  local uid=$(get_user_id "$name")
  if [ -z "$uid" ]; then
    echo -e "  ${RED}Usuario nao encontrado${NC}"
    pause
    return
  fi
  echo -ne "  ${YELLOW}Quantos eventos (default 20): ${NC}"
  read limit
  limit=${limit:-20}
  echo -e "\n  ${CYAN}Ultimos $limit eventos de '$name':${NC}\n"
  query "message_events?user_id=eq.${uid}&order=timestamp.desc&limit=${limit}&select=phone_client,direction,message_type,char_count,response_time_seconds,timestamp"
  pause
}

opt_team_overview() {
  echo -e "\n  ${CYAN}Resumo do time (hoje):${NC}\n"
  rpc "get_team_overview" '{}'
  pause
}

opt_user_abas() {
  echo -ne "\n  ${YELLOW}Nome do usuario: ${NC}"
  read name
  local uid=$(get_user_id "$name")
  if [ -z "$uid" ]; then
    echo -e "  ${RED}Usuario nao encontrado${NC}"
    pause
    return
  fi
  echo -e "\n  ${CYAN}Abas de '$name':${NC}\n"
  query "abas?user_id=eq.${uid}&select=id,name,color,created_at&order=created_at.asc"
  pause
}

opt_user_labels() {
  echo -ne "\n  ${YELLOW}Nome do usuario: ${NC}"
  read name
  local uid=$(get_user_id "$name")
  if [ -z "$uid" ]; then
    echo -e "  ${RED}Usuario nao encontrado${NC}"
    pause
    return
  fi
  echo -e "\n  ${CYAN}Labels de '$name':${NC}\n"
  query "labels?user_id=eq.${uid}&select=contact_phone,contact_name,color,text,created_at&order=created_at.desc&limit=50"
  pause
}

opt_user_observations() {
  echo -ne "\n  ${YELLOW}Nome do usuario: ${NC}"
  read name
  local uid=$(get_user_id "$name")
  if [ -z "$uid" ]; then
    echo -e "  ${RED}Usuario nao encontrado${NC}"
    pause
    return
  fi
  echo -e "\n  ${CYAN}Observacoes de '$name':${NC}\n"
  query "observations?user_id=eq.${uid}&select=contact_phone,contact_name,content,created_at,updated_at&order=updated_at.desc&limit=20"
  pause
}

opt_user_sequences() {
  echo -ne "\n  ${YELLOW}Nome do usuario: ${NC}"
  read name
  local uid=$(get_user_id "$name")
  if [ -z "$uid" ]; then
    echo -e "  ${RED}Usuario nao encontrado${NC}"
    pause
    return
  fi
  echo -e "\n  ${CYAN}Sequencias de mensagem de '$name':${NC}\n"
  query "msg_sequences?user_id=eq.${uid}&select=contact_phone,contact_name,status,messages,created_at&order=created_at.desc&limit=20"
  pause
}

opt_global_messages() {
  echo -e "\n  ${CYAN}Mensagens globais:${NC}\n"
  query "global_messages?select=id,title,content,category,active,created_at&order=created_at.desc&limit=20"
  pause
}

opt_free_sql() {
  echo -e "\n  ${YELLOW}Digite a query SQL:${NC}"
  echo -ne "  > "
  read sql_query
  echo -e "\n  ${CYAN}Resultado:${NC}\n"
  curl -s "$BASE_URL/rpc/execute_sql" -X POST "${HEADERS[@]}" \
    -d "{\"query\": \"$sql_query\"}" | format_json
  echo -e "\n  ${RED}Nota: precisa da funcao execute_sql no Supabase.${NC}"
  echo -e "  ${RED}Alternativa: use a opcao 14 (REST) ou o Dashboard.${NC}"
  pause
}

opt_free_rest() {
  echo -e "\n  ${YELLOW}Digite o path REST (ex: users?select=name&limit=5):${NC}"
  echo -ne "  > "
  read rest_path
  echo -e "\n  ${CYAN}Resultado:${NC}\n"
  query "$rest_path"
  pause
}

# =====================================================
# MAIN LOOP
# =====================================================

# Check dependencies
if ! command -v curl &> /dev/null; then
  echo -e "${RED}curl nao encontrado. Instale com: pkg install curl${NC}"
  exit 1
fi
if ! command -v python3 &> /dev/null; then
  echo -e "${YELLOW}python3 nao encontrado. JSON nao sera formatado.${NC}"
  echo -e "${YELLOW}Instale com: pkg install python${NC}"
  echo ""
fi

while true; do
  show_menu
  read choice
  case $choice in
    1)  opt_list_users ;;
    2)  opt_search_name ;;
    3)  opt_search_email ;;
    4)  opt_users_status ;;
    5)  opt_user_activity ;;
    6)  opt_message_events ;;
    7)  opt_team_overview ;;
    8)  opt_user_abas ;;
    9)  opt_user_labels ;;
    10) opt_user_observations ;;
    11) opt_user_sequences ;;
    12) opt_global_messages ;;
    13) opt_free_sql ;;
    14) opt_free_rest ;;
    0)  echo -e "\n  ${GREEN}Ate mais!${NC}\n"; exit 0 ;;
    *)  echo -e "  ${RED}Opcao invalida${NC}"; sleep 1 ;;
  esac
done
