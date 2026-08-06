#include "storage/sqlite_store.hpp"

#include <exception>
#include <iostream>
#include <stdexcept>
#include <string>

int main(int argc, char* argv[]) {
  try {
    const std::string path = argc > 1 ? argv[1] : "edge/db/wardy.sqlite";
    if (argc > 2) throw std::invalid_argument("usage: wardy_db_probe [database path]");
    wardy::storage::SqliteStore store(path);
    store.initialize();
    std::cout << "database_ready path=" << store.path()
              << " schema_version=1 journal_mode=" << store.journal_mode() << '\n';
    return 0;
  } catch (const std::exception& error) {
    std::cerr << "database_probe_error: " << error.what() << '\n';
    return 1;
  }
}
