#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <unistd.h>
#include <sys/time.h>
#include <time.h>

#define RED     "\033[1;31m"
#define GREEN   "\033[1;32m"
#define YELLOW  "\033[1;33m"
#define BLUE    "\033[1;34m"
#define MAGENTA "\033[1;35m"
#define CYAN    "\033[1;36m"
#define RESET   "\033[0m"

typedef struct {
    char description[256];
    char command[512];
    int success;
    long long duration_ms;
} TestCase;

long long get_current_time_ms() {
    struct timeval tv;
    gettimeofday(&tv, NULL);
    return (long long)tv.tv_sec * 1000 + tv.tv_usec / 1000;
}

int execute_test(TestCase *test) {
    printf("%-50s", test->description);
    fflush(stdout);
    
    long long start_time = get_current_time_ms();
    int result = system(test->command);
    long long end_time = get_current_time_ms();
    
    test->duration_ms = end_time - start_time;
    test->success = (result == 0);
    
    if (test->success) {
        printf("[" GREEN "✓ PASS" RESET "]");
    } else {
        printf("[" RED "✗ FAIL" RESET "]");
    }
    
    printf(" %s%4lld ms%s\n", CYAN, test->duration_ms, RESET);
    return test->success;
}

void run_performance_test() {
    printf("\n" MAGENTA "🚀 PERFORMANCE TEST - Inserting 100 records" RESET "\n");
    
    long long start_time = get_current_time_ms();
    int success_count = 0;
    
    for (int i = 0; i < 100; i++) {
        char command[512];
        snprintf(command, sizeof(command),
                 "./sydb create perfdb users --insert-one --name-\"User%d\" --age-%d --email-\"user%d@perf.com\" --active-true > /dev/null 2>&1",
                 i, 20 + (i % 40), i);
        
        if (system(command) == 0) {
            success_count++;
        }
        
        // Progress indicator
        if ((i + 1) % 10 == 0) {
            printf(YELLOW "➤ Progress: %d/100\n" RESET, i + 1);
        }
    }
    
    long long end_time = get_current_time_ms();
    long long total_time = end_time - start_time;
    double avg_time = (double)total_time / 100;
    
    printf("Performance Results:\n");
    printf("  Total time: " CYAN "%lld ms" RESET "\n", total_time);
    printf("  Average per insert: " CYAN "%.2f ms" RESET "\n", avg_time);
    printf("  Success rate: " GREEN "%d/100" RESET " records\n", success_count);
    printf("  Throughput: " GREEN "%.2f" RESET " ops/sec\n", 100000.0 / total_time);
}

void print_fancy_result(int passed, int total, long long total_time) {
    printf("\n" "▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄\n");
    printf("█" BLUE "                TEST RESULTS               " RESET "█\n");
    printf("█▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄█\n");
    
    double percentage = (double)passed / total * 100;
    char *color = (percentage >= 80) ? GREEN : (percentage >= 60) ? YELLOW : RED;
    char *emoji = (percentage >= 80) ? "🎉" : (percentage >= 60) ? "⚠️ " : "💥";
    
    printf("█  Tests Passed: " GREEN "%d/%d" RESET " (%s%.1f%%%s) %s  █\n", 
           passed, total, color, percentage, RESET, emoji);
    printf("█  Total Time: " CYAN "%lld ms" RESET "                     █\n", total_time);
    printf("█  Status: %s%-20s" RESET "           █\n", 
           color, (percentage >= 80) ? "EXCELLENT" : (percentage >= 60) ? "ACCEPTABLE" : "NEEDS WORK");
    
    // Progress bar
    printf("█  Progress: [");
    int bar_width = 30;
    int filled = (int)((double)passed / total * bar_width);
    for (int i = 0; i < bar_width; i++) {
        if (i < filled) printf(GREEN "█" RESET);
        else printf("░");
    }
    printf("] █\n");
    
    printf("▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀\n\n");
}

int main() {
    setenv("SYDB_BASE_DIR", "/tmp/sydb_test", 1);
    
    printf(CYAN "🧪 SYDB MINIMALIST TEST SUITE\n" RESET);
    printf("═══════════════════════════════════════════════\n\n");
    
    TestCase tests[] = {
        // Database Operations
        {"Create database", "./sydb create testdb > /dev/null 2>&1", 0, 0},
        {"Create second database", "./sydb create testdb2 > /dev/null 2>&1", 0, 0},
        {"List databases", "./sydb list > /dev/null 2>&1", 0, 0},
        
        // Collection Operations  
        {"Create users collection", "./sydb create testdb users --schema --name-string-req --age-int --email-string > /dev/null 2>&1", 0, 0},
        {"Create products collection", "./sydb create testdb products --schema --name-string-req --price-float > /dev/null 2>&1", 0, 0},
        {"View schema", "./sydb schema testdb users > /dev/null 2>&1", 0, 0},
        
        // Insert Operations
        {"Insert user record", "./sydb create testdb users --insert-one --name-\"John\" --age-25 --email-\"john@test.com\" > /dev/null 2>&1", 0, 0},
        {"Insert product record", "./sydb create testdb products --insert-one --name-\"Laptop\" --price-999.99 > /dev/null 2>&1", 0, 0},
        
        // Query Operations
        {"Query users", "./sydb find testdb users --where \"age:25\" > /dev/null 2>&1", 0, 0},
        {"Query products", "./sydb find testdb products --where \"name:Laptop\" > /dev/null 2>&1", 0, 0},
        
        // List Operations
        {"List collections", "./sydb list testdb > /dev/null 2>&1", 0, 0},
        {"List users", "./sydb list testdb users > /dev/null 2>&1", 0, 0},
    };
    
    int total_tests = sizeof(tests) / sizeof(tests[0]);
    int passed_tests = 0;
    long long total_duration = 0;
    
    // Cleanup previous test
    system("rm -rf /tmp/sydb_test > /dev/null 2>&1");
    
    // Run all tests
    for (int i = 0; i < total_tests; i++) {
        if (execute_test(&tests[i])) {
            passed_tests++;
        }
        total_duration += tests[i].duration_ms;
    }
    
    // Performance test
    system("./sydb create perfdb users --schema --name-string-req --age-int --email-string > /dev/null 2>&1");
    run_performance_test();
    
    // Cleanup performance db
    system("rm -rf /tmp/sydb_test/perfdb > /dev/null 2>&1");
    
    // Final result
    print_fancy_result(passed_tests, total_tests, total_duration);
    
    return (passed_tests == total_tests) ? 0 : 1;
}
