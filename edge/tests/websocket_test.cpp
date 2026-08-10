#include "api/websocket.hpp"

#undef NDEBUG
#include <cassert>
#include <string>

int main() {
  assert(wardy::api::websocket_accept_key("dGhlIHNhbXBsZSBub25jZQ==") ==
         "s3pPLMBiTxaQ9kYGzzhZRbK+xOo=");
  const std::string small = wardy::api::websocket_text_frame("hello");
  assert(static_cast<unsigned char>(small[0]) == 0x81U);
  assert(static_cast<unsigned char>(small[1]) == 5U);
  assert(small.substr(2) == "hello");
  const std::string medium = wardy::api::websocket_text_frame(std::string(126, 'x'));
  assert(static_cast<unsigned char>(medium[1]) == 126U);
  assert(static_cast<unsigned char>(medium[2]) == 0U);
  assert(static_cast<unsigned char>(medium[3]) == 126U);
  return 0;
}
