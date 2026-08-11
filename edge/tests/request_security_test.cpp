#ifdef NDEBUG
#undef NDEBUG
#endif

#include "api/request_security.hpp"

#include <cassert>

int main() {
  assert(wardy::api::protected_api_path("/api/llm/daily-summary"));
  assert(!wardy::api::protected_api_path("/api/health"));
  assert(!wardy::api::access_token_authorized(
      "POST /api/llm/daily-summary HTTP/1.1\r\n\r\n", "secret"));
  assert(!wardy::api::access_token_authorized(
      "POST /api/llm/daily-summary HTTP/1.1\r\nX-Wardy-Access-Token: wrong\r\n\r\n",
      "secret"));
  assert(wardy::api::access_token_authorized(
      "POST /api/llm/daily-summary HTTP/1.1\r\nX-Wardy-Access-Token: secret\r\n\r\n",
      "secret"));
}
