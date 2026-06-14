#include "calc.h"

static int helper_internal() { return 2; }

int shared_util() {
  return helper_internal();                // intra-file -> direct/likely
}
