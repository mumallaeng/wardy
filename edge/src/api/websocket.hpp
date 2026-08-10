#pragma once

#include <array>
#include <cstdint>
#include <string>
#include <vector>

namespace wardy::api {

namespace detail {

inline std::uint32_t rotate_left(std::uint32_t value, unsigned count) {
  return (value << count) | (value >> (32U - count));
}

inline std::array<unsigned char, 20> sha1(const std::string& input) {
  std::vector<unsigned char> message(input.begin(), input.end());
  const std::uint64_t bit_length = static_cast<std::uint64_t>(message.size()) * 8U;
  message.push_back(0x80);
  while ((message.size() % 64U) != 56U) message.push_back(0);
  for (int shift = 56; shift >= 0; shift -= 8) {
    message.push_back(static_cast<unsigned char>((bit_length >> shift) & 0xffU));
  }

  std::uint32_t h0 = 0x67452301U;
  std::uint32_t h1 = 0xefcdab89U;
  std::uint32_t h2 = 0x98badcfeU;
  std::uint32_t h3 = 0x10325476U;
  std::uint32_t h4 = 0xc3d2e1f0U;
  for (std::size_t offset = 0; offset < message.size(); offset += 64U) {
    std::array<std::uint32_t, 80> words{};
    for (std::size_t index = 0; index < 16U; ++index) {
      const std::size_t base = offset + index * 4U;
      words[index] = (static_cast<std::uint32_t>(message[base]) << 24U) |
          (static_cast<std::uint32_t>(message[base + 1]) << 16U) |
          (static_cast<std::uint32_t>(message[base + 2]) << 8U) |
          static_cast<std::uint32_t>(message[base + 3]);
    }
    for (std::size_t index = 16U; index < words.size(); ++index) {
      words[index] = rotate_left(words[index - 3U] ^ words[index - 8U] ^
                                 words[index - 14U] ^ words[index - 16U], 1U);
    }
    std::uint32_t a = h0, b = h1, c = h2, d = h3, e = h4;
    for (std::size_t index = 0; index < words.size(); ++index) {
      std::uint32_t function = 0;
      std::uint32_t constant = 0;
      if (index < 20U) { function = (b & c) | ((~b) & d); constant = 0x5a827999U; }
      else if (index < 40U) { function = b ^ c ^ d; constant = 0x6ed9eba1U; }
      else if (index < 60U) { function = (b & c) | (b & d) | (c & d); constant = 0x8f1bbcdcU; }
      else { function = b ^ c ^ d; constant = 0xca62c1d6U; }
      const std::uint32_t temporary = rotate_left(a, 5U) + function + e +
          constant + words[index];
      e = d; d = c; c = rotate_left(b, 30U); b = a; a = temporary;
    }
    h0 += a; h1 += b; h2 += c; h3 += d; h4 += e;
  }
  std::array<unsigned char, 20> digest{};
  const std::array<std::uint32_t, 5> hashes{h0, h1, h2, h3, h4};
  for (std::size_t index = 0; index < hashes.size(); ++index) {
    for (std::size_t byte = 0; byte < 4U; ++byte) {
      digest[index * 4U + byte] = static_cast<unsigned char>(
          (hashes[index] >> (24U - static_cast<unsigned>(byte) * 8U)) & 0xffU);
    }
  }
  return digest;
}

inline std::string base64(const unsigned char* data, std::size_t size) {
  constexpr char alphabet[] =
      "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
  std::string output;
  output.reserve(((size + 2U) / 3U) * 4U);
  for (std::size_t index = 0; index < size; index += 3U) {
    const std::uint32_t block = (static_cast<std::uint32_t>(data[index]) << 16U) |
        (index + 1U < size ? static_cast<std::uint32_t>(data[index + 1U]) << 8U : 0U) |
        (index + 2U < size ? static_cast<std::uint32_t>(data[index + 2U]) : 0U);
    output.push_back(alphabet[(block >> 18U) & 0x3fU]);
    output.push_back(alphabet[(block >> 12U) & 0x3fU]);
    output.push_back(index + 1U < size ? alphabet[(block >> 6U) & 0x3fU] : '=');
    output.push_back(index + 2U < size ? alphabet[block & 0x3fU] : '=');
  }
  return output;
}

}  // namespace detail

inline std::string websocket_accept_key(const std::string& client_key) {
  const auto digest = detail::sha1(client_key + "258EAFA5-E914-47DA-95CA-C5AB0DC85B11");
  return detail::base64(digest.data(), digest.size());
}

inline std::string websocket_text_frame(const std::string& text) {
  std::string frame;
  frame.push_back(static_cast<char>(0x81));
  const std::size_t size = text.size();
  if (size <= 125U) {
    frame.push_back(static_cast<char>(size));
  } else if (size <= 65535U) {
    frame.push_back(static_cast<char>(126));
    frame.push_back(static_cast<char>((size >> 8U) & 0xffU));
    frame.push_back(static_cast<char>(size & 0xffU));
  } else {
    frame.push_back(static_cast<char>(127));
    for (int shift = 56; shift >= 0; shift -= 8) {
      frame.push_back(static_cast<char>((static_cast<std::uint64_t>(size) >> shift) & 0xffU));
    }
  }
  frame += text;
  return frame;
}

}  // namespace wardy::api
