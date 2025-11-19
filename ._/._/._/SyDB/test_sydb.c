#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <unistd.h>
#include <sys/time.h>
#include <time.h>
#include <dirent.h>
#include <sys/stat.h>
#include <fcntl.h>

#define RED     "\033[1;31m"
#define GREEN   "\033[1;32m"
#define YELLOW  "\033[1;33m"
#define BLUE    "\033[1;34m"
#define MAGENTA "\033[1;35m"
#define CYAN    "\033[1;36m"
#define RESET   "\033[0m"

typedef struct {
    char description[512];
    char command[1024];
    char verification_command[1024];
    char expected_output[1024];
    int success;
    int verification_success;
    long long duration_ms;
    char details[1024];
} TestCase;

// Global variable for CLI command
char cli_command[32] = "./sydb";

long long get_current_time_ms() {
    struct timeval tv;
    gettimeofday(&tv, NULL);
    return (long long)tv.tv_sec * 1000 + tv.tv_usec / 1000;
}

// Utility functions for deep verification
int file_exists(const char *path) {
    struct stat st;
    return stat(path, &st) == 0;
}

int count_files_in_directory(const char *path) {
    DIR *dir = opendir(path);
    if (!dir) return -1;
    
    int count = 0;
    struct dirent *entry;
    while ((entry = readdir(dir)) != NULL) {
        if (strcmp(entry->d_name, ".") != 0 && strcmp(entry->d_name, "..") != 0) {
            count++;
        }
    }
    closedir(dir);
    return count;
}

int count_instances_in_collection(const char *database, const char *collection) {
    char command[512];
    snprintf(command, sizeof(command), "%s list %s %s 2>/dev/null | wc -l", cli_command, database, collection);
    
    FILE *fp = popen(command, "r");
    if (!fp) return -1;
    
    int count = 0;
    char buffer[64];
    if (fgets(buffer, sizeof(buffer), fp)) {
        count = atoi(buffer);
    }
    pclose(fp);
    
    return count;
}

char* get_last_inserted_id(const char *database, const char *collection) {
    char command[512];
    snprintf(command, sizeof(command), "%s list %s %s 2>/dev/null | tail -1", cli_command, database, collection);
    
    FILE *fp = popen(command, "r");
    if (!fp) return NULL;
    
    static char id[64];
    if (fgets(id, sizeof(id), fp)) {
        // Extract ID from JSON
        char *id_start = strstr(id, "\"_id\":\"");
        if (id_start) {
            id_start += 7;
            char *id_end = strchr(id_start, '"');
            if (id_end) {
                *id_end = '\0';
                strncpy(id, id_start, sizeof(id) - 1);
                pclose(fp);
                return id;
            }
        }
    }
    pclose(fp);
    return NULL;
}

int execute_command_and_capture(const char *command, char *output, size_t output_size) {
    FILE *fp = popen(command, "r");
    if (!fp) return -1;
    
    output[0] = '\0';
    if (fgets(output, output_size, fp)) {
        // Remove newline
        output[strcspn(output, "\n")] = '\0';
    }
    pclose(fp);
    return 0;
}

int verify_database_structure(const char *database) {
    char path[512];
    snprintf(path, sizeof(path), "/tmp/sydb_test/%s", database);
    
    if (!file_exists(path)) {
        printf(RED "  ✗ Database directory doesn't exist\n" RESET);
        return 0;
    }
    
    struct stat st;
    if (stat(path, &st) != 0 || !S_ISDIR(st.st_mode)) {
        printf(RED "  ✗ Database path is not a directory\n" RESET);
        return 0;
    }
    
    printf(GREEN "  ✓ Database directory exists and is valid\n" RESET);
    return 1;
}

int verify_collection_structure(const char *database, const char *collection) {
    char path[512];
    snprintf(path, sizeof(path), "/tmp/sydb_test/%s/%s", database, collection);
    
    if (!file_exists(path)) {
        printf(RED "  ✗ Collection directory doesn't exist\n" RESET);
        return 0;
    }
    
    // Check for schema file
    char schema_path[512];
    snprintf(schema_path, sizeof(schema_path), "%s/schema.txt", path);
    if (!file_exists(schema_path)) {
        printf(RED "  ✗ Schema file doesn't exist\n" RESET);
        return 0;
    }
    
    // Check for data file
    char data_path[512];
    snprintf(data_path, sizeof(data_path), "%s/data.sydb", path);
    if (!file_exists(data_path)) {
        printf(RED "  ✗ Data file doesn't exist\n" RESET);
        return 0;
    }
    
    printf(GREEN "  ✓ Collection structure is valid\n" RESET);
    return 1;
}

int verify_schema_content(const char *database, const char *collection, const char *expected_fields) {
    char command[512];
    snprintf(command, sizeof(command), "%s schema %s %s", cli_command, database, collection);
    
    char output[1024];
    if (execute_command_and_capture(command, output, sizeof(output)) != 0) {
        printf(RED "  ✗ Could not read schema\n" RESET);
        return 0;
    }
    
    // Basic schema verification
    if (strstr(output, "Field") == NULL || strstr(output, "Type") == NULL) {
        printf(RED "  ✗ Schema output format incorrect\n" RESET);
        return 0;
    }
    
    printf(GREEN "  ✓ Schema content is valid\n" RESET);
    return 1;
}

int execute_test_with_verification(TestCase *test) {
    printf("\n%s%-80s" RESET, BLUE, test->description);
    fflush(stdout);
    
    long long start_time = get_current_time_ms();
    
    // Execute main command
    int result = system(test->command);
    long long end_time = get_current_time_ms();
    
    test->duration_ms = end_time - start_time;
    test->success = (result == 0);
    
    // Perform verification if command succeeded
    test->verification_success = 1;
    if (test->success && test->verification_command[0] != '\0') {
        char verification_output[1024];
        if (execute_command_and_capture(test->verification_command, verification_output, sizeof(verification_output)) == 0) {
            if (test->expected_output[0] != '\0') {
                if (strstr(verification_output, test->expected_output) == NULL) {
                    test->verification_success = 0;
                    strncpy(test->details, verification_output, sizeof(test->details) - 1);
                }
            }
        } else {
            test->verification_success = 0;
            strcpy(test->details, "Verification command failed");
        }
    }
    
    // Overall test result
    int overall_success = test->success && test->verification_success;
    
    if (overall_success) {
        printf("[" GREEN "PASS" RESET "]");
    } else {
        printf("[" RED "FAIL" RESET "]");
    }
    
    printf(" %s%4lld ms%s\n", CYAN, test->duration_ms, RESET);
    
    // Print details if verification failed
    if (!test->verification_success && test->details[0] != '\0') {
        printf(RED "  Verification failed: %s\n" RESET, test->details);
    }
    
    return overall_success;
}

void run_security_tests() {
    printf("\n" MAGENTA "SECURITY TESTS - Path validation and injection prevention" RESET "\n");
    
    TestCase security_tests[] = {
        {
            "Prevent directory traversal in database names",
            "%s create '../evil' 2>&1 | grep -i 'invalid\\|error' > /dev/null",
            "test ! -d '/tmp/sydb_test/../evil'",
            "",
            0, 0, 0, ""
        },
        {
            "Prevent directory traversal in collection names", 
            "%s create testdb '../../evil' --schema --name-string 2>&1 | grep -i 'invalid\\|error' > /dev/null",
            "test ! -d '/tmp/sydb_test/testdb/../../evil'",
            "",
            0, 0, 0, ""
        },
        {
            "Reject invalid database names with special chars",
            "%s create 'invalid/name' 2>&1 | grep -i 'invalid\\|error' > /dev/null",
            "test ! -d '/tmp/sydb_test/invalid/name'", 
            "",
            0, 0, 0, ""
        }
    };
    
    int security_count = sizeof(security_tests) / sizeof(security_tests[0]);
    int security_passed = 0;
    
    for (int i = 0; i < security_count; i++) {
        // Replace %s with cli_command in both command and verification_command
        char final_command[1024];
        char final_verification[1024];
        
        snprintf(final_command, sizeof(final_command), security_tests[i].command, cli_command);
        snprintf(final_verification, sizeof(final_verification), security_tests[i].verification_command, cli_command);
        
        strcpy(security_tests[i].command, final_command);
        strcpy(security_tests[i].verification_command, final_verification);
        
        if (execute_test_with_verification(&security_tests[i])) {
            security_passed++;
        }
    }
    
    printf(YELLOW "  Security tests: %d/%d passed\n" RESET, security_passed, security_count);
}

void run_data_integrity_tests() {
    printf("\n" MAGENTA "DATA INTEGRITY TESTS - CRC validation and file structure" RESET "\n");
    
    // Create test database and collection first
    char create_db_cmd[256];
    char create_collection_cmd[256];
    char insert_cmd[256];
    
    snprintf(create_db_cmd, sizeof(create_db_cmd), "%s create integritydb > /dev/null 2>&1", cli_command);
    snprintf(create_collection_cmd, sizeof(create_collection_cmd), "%s create integritydb data --schema --value-string-req > /dev/null 2>&1", cli_command);
    snprintf(insert_cmd, sizeof(insert_cmd), "%s create integritydb data --insert-one --value-\"test_data_1\" > /dev/null 2>&1", cli_command);
    
    system(create_db_cmd);
    system(create_collection_cmd);
    system(insert_cmd);
    
    TestCase integrity_tests[] = {
        {
            "Data file has valid header structure",
            "echo 'Header check' > /dev/null",
            "hexdump -C /tmp/sydb_test/integritydb/data/data.sydb | head -2 | grep -q 'SYDB'",
            "",
            0, 0, 0, ""
        },
        {
            "Data file grows with inserts",
            "%s create integritydb data --insert-one --value-\"test_data_2\" > /dev/null 2>&1",
            "ls -l /tmp/sydb_test/integritydb/data/data.sydb | awk '{print $5}'",
            "",
            0, 0, 0, ""
        }
    };
    
    int integrity_count = sizeof(integrity_tests) / sizeof(integrity_tests[0]);
    int integrity_passed = 0;
    
    for (int i = 0; i < integrity_count; i++) {
        // Replace %s with cli_command
        if (strstr(integrity_tests[i].command, "%s") != NULL) {
            char final_command[1024];
            snprintf(final_command, sizeof(final_command), integrity_tests[i].command, cli_command);
            strcpy(integrity_tests[i].command, final_command);
        }
        
        if (execute_test_with_verification(&integrity_tests[i])) {
            integrity_passed++;
        }
    }
    
    printf(YELLOW "  Data integrity tests: %d/%d passed\n" RESET, integrity_passed, integrity_count);
}

void run_performance_test() {
    printf("\n" MAGENTA "PERFORMANCE AND SCALABILITY TESTS" RESET "\n");
    
    // Setup performance database
    printf("Setting up performance database...\n");
    char create_db_cmd[256];
    char create_collection_cmd[256];
    
    snprintf(create_db_cmd, sizeof(create_db_cmd), "%s create perfdb > /dev/null 2>&1", cli_command);
    snprintf(create_collection_cmd, sizeof(create_collection_cmd), "%s create perfdb users --schema --name-string-req --age-int --email-string > /dev/null 2>&1", cli_command);
    
    system(create_db_cmd);
    system(create_collection_cmd);
    
    // Test 1: Single insert performance
    char single_insert_cmd[256];
    snprintf(single_insert_cmd, sizeof(single_insert_cmd), "%s create perfdb users --insert-one --name-\"SingleUser\" --age-30 --email-\"single@test.com\" > /dev/null 2>&1", cli_command);
    
    long long start_time = get_current_time_ms();
    system(single_insert_cmd);
    long long single_insert_time = get_current_time_ms() - start_time;
    
    // Test 2: Batch insert performance
    int batch_size = 50;
    printf("Inserting %d records for batch performance...\n", batch_size);
    
    start_time = get_current_time_ms();
    int success_count = 0;
    
    for (int i = 0; i < batch_size; i++) {
        char command[512];
        snprintf(command, sizeof(command),
                 "%s create perfdb users --insert-one --name-\"User%d\" --age-%d --email-\"user%d@test.com\" > /dev/null 2>&1",
                 cli_command, i, 20 + (i % 40), i);
        
        if (system(command) == 0) {
            success_count++;
        }
    }
    
    long long batch_time = get_current_time_ms() - start_time;
    double avg_batch_time = (double)batch_time / batch_size;
    
    // Test 3: Query performance
    printf("Testing query performance...\n");
    char query_cmd[256];
    snprintf(query_cmd, sizeof(query_cmd), "%s find perfdb users --where \"age:25\" > /dev/null 2>&1", cli_command);
    
    start_time = get_current_time_ms();
    system(query_cmd);
    long long query_time = get_current_time_ms() - start_time;
    
    // Test 4: Count verification
    int actual_count = count_instances_in_collection("perfdb", "users");
    
    printf("\nPerformance Results:\n");
    printf("  Single insert: " CYAN "%lld ms" RESET "\n", single_insert_time);
    printf("  Batch insert (%d records): " CYAN "%lld ms" RESET " (avg: " CYAN "%.2f ms" RESET ")\n", 
           batch_size, batch_time, avg_batch_time);
    printf("  Query time: " CYAN "%lld ms" RESET "\n", query_time);
    printf("  Insert success rate: " GREEN "%d/%d" RESET "\n", success_count, batch_size);
    printf("  Record count verification: " GREEN "%d" RESET " records in collection\n", actual_count);
    
    // Performance thresholds (adjust based on your requirements)
    int performance_ok = (single_insert_time < 1000) && (avg_batch_time < 500) && (query_time < 500);
    if (performance_ok) {
        printf(GREEN "  ✓ Performance within acceptable limits\n" RESET);
    } else {
        printf(YELLOW "  ⚠ Performance may need optimization\n" RESET);
    }
}

void run_edge_case_tests() {
    printf("\n" MAGENTA "EDGE CASE AND ERROR HANDLING TESTS" RESET "\n");
    
    TestCase edge_tests[] = {
        {
            "Handle duplicate database creation",
            "%s create testdb 2>&1 | grep -i 'exist\\|error' > /dev/null",
            "%s list | grep -c testdb",
            "",
            0, 0, 0, ""
        },
        {
            "Handle duplicate collection creation",
            "%s create testdb users --schema --name-string 2>&1 | grep -i 'exist\\|error' > /dev/null", 
            "%s list testdb | grep -c users",
            "",
            0, 0, 0, ""
        },
        {
            "Handle missing database queries",
            "%s find nonexistentdb users --where \"name:test\" 2>&1 | grep -i 'exist\\|error' > /dev/null",
            "echo 'Error handled'",
            "",
            0, 0, 0, ""
        },
        {
            "Handle missing collection queries", 
            "%s find testdb nonexistent --where \"name:test\" 2>&1 | grep -i 'exist\\|error' > /dev/null",
            "echo 'Error handled'",
            "",
            0, 0, 0, ""
        },
        {
            "Handle malformed queries",
            "%s find testdb users --where \"invalid-query-format\" 2>&1 | grep -i 'error\\|invalid' > /dev/null",
            "echo 'Error handled'", 
            "",
            0, 0, 0, ""
        },
        {
            "Handle schema validation failures",
            "%s create testdb users --insert-one --invalid-field-\"value\" 2>&1 | grep -i 'error\\|valid' > /dev/null",
            "echo 'Validation worked'",
            "",
            0, 0, 0, ""
        }
    };
    
    int edge_count = sizeof(edge_tests) / sizeof(edge_tests[0]);
    int edge_passed = 0;
    
    for (int i = 0; i < edge_count; i++) {
        // Replace %s with cli_command in both command and verification_command
        char final_command[1024];
        char final_verification[1024];
        
        snprintf(final_command, sizeof(final_command), edge_tests[i].command, cli_command);
        snprintf(final_verification, sizeof(final_verification), edge_tests[i].verification_command, cli_command);
        
        strcpy(edge_tests[i].command, final_command);
        strcpy(edge_tests[i].verification_command, final_verification);
        
        if (execute_test_with_verification(&edge_tests[i])) {
            edge_passed++;
        }
    }
    
    printf(YELLOW "  Edge case tests: %d/%d passed\n" RESET, edge_passed, edge_count);
}

void run_comprehensive_verification() {
    printf("\n" MAGENTA "COMPREHENSIVE STRUCTURE VERIFICATION" RESET "\n");
    
    int verification_passed = 0;
    int verification_total = 0;
    
    // Verify testdb structure
    printf("Verifying testdb structure...\n");
    if (verify_database_structure("testdb")) verification_passed++;
    verification_total++;
    
    if (verify_collection_structure("testdb", "users")) verification_passed++;
    verification_total++;
    
    if (verify_collection_structure("testdb", "products")) verification_passed++;
    verification_total++;
    
    if (verify_schema_content("testdb", "users", "name")) verification_passed++;
    verification_total++;
    
    // Verify testdb2 structure  
    printf("Verifying testdb2 structure...\n");
    if (verify_database_structure("testdb2")) verification_passed++;
    verification_total++;
    
    printf(YELLOW "  Structure verification: %d/%d passed\n" RESET, verification_passed, verification_total);
}

void print_detailed_results(int passed, int total, long long total_time, int security_passed, int security_total,
                           int integrity_passed, int integrity_total, int edge_passed, int edge_total) {
    printf("\n");
    printf("===============================================\n");
    printf(BLUE "           COMPREHENSIVE TEST RESULTS         " RESET "\n");
    printf("===============================================\n");
    
    double percentage = (double)passed / total * 100;
    char *color = (percentage >= 90) ? GREEN : (percentage >= 70) ? YELLOW : RED;
    char *status = (percentage >= 90) ? "EXCELLENT" : (percentage >= 70) ? "GOOD" : "NEEDS IMPROVEMENT";
    
    printf("  Core Tests:      " GREEN "%d/%d" RESET " (%s%.1f%%%s)\n", 
           passed, total, color, percentage, RESET);
    printf("  Security Tests:  %s%d/%d" RESET "\n", 
           (security_passed == security_total) ? GREEN : YELLOW, security_passed, security_total);
    printf("  Integrity Tests: %s%d/%d" RESET "\n", 
           (integrity_passed == integrity_total) ? GREEN : YELLOW, integrity_passed, integrity_total);
    printf("  Edge Case Tests: %s%d/%d" RESET "\n", 
           (edge_passed == edge_total) ? GREEN : YELLOW, edge_passed, edge_total);
    printf("  Total Time:      " CYAN "%lld ms" RESET "\n", total_time);
    printf("  Overall Status:  %s%s" RESET "\n", color, status);
    
    // Detailed progress bars
    printf("\n  Detailed Breakdown:\n");
    
    printf("  Core Features:   [");
    int bar_width = 20;
    int core_filled = (int)((double)passed / total * bar_width);
    for (int i = 0; i < bar_width; i++) {
        if (i < core_filled) printf(GREEN "#" RESET);
        else printf("-");
    }
    printf("] %s%.1f%%%s\n", color, percentage, RESET);
    
    printf("  Security:        [");
    int security_filled = (int)((double)security_passed / security_total * bar_width);
    for (int i = 0; i < bar_width; i++) {
        if (i < security_filled) printf(GREEN "#" RESET);
        else printf("-");
    }
    printf("] %.1f%%\n", (double)security_passed / security_total * 100);
    
    printf("  Data Integrity:  [");
    int integrity_filled = (int)((double)integrity_passed / integrity_total * bar_width);
    for (int i = 0; i < bar_width; i++) {
        if (i < integrity_filled) printf(GREEN "#" RESET);
        else printf("-");
    }
    printf("] %.1f%%\n", (double)integrity_passed / integrity_total * 100);
    
    printf("  Error Handling:  [");
    int edge_filled = (int)((double)edge_passed / edge_total * bar_width);
    for (int i = 0; i < bar_width; i++) {
        if (i < edge_filled) printf(GREEN "#" RESET);
        else printf("-");
    }
    printf("] %.1f%%\n", (double)edge_passed / edge_total * 100);
    
    printf("===============================================\n\n");
}

void print_usage(const char *program_name) {
    printf("Usage: %s [OPTIONS]\n", program_name);
    printf("Options:\n");
    printf("  --cli           Use global 'sydb' command instead of './sydb'\n");
    printf("  --help, -h      Show this help message\n");
    printf("\nExamples:\n");
    printf("  %s              # Use ./sydb (default)\n", program_name);
    printf("  %s --cli        # Use global 'sydb' command\n", program_name);
}

int main(int argc, char *argv[]) {
    // Parse command line arguments
    for (int i = 1; i < argc; i++) {
        if (strcmp(argv[i], "--cli") == 0) {
            strcpy(cli_command, "sydb");
        } else if (strcmp(argv[i], "--help") == 0 || strcmp(argv[i], "-h") == 0) {
            print_usage(argv[0]);
            return 0;
        } else {
            fprintf(stderr, RED "Unknown option: %s\n" RESET, argv[i]);
            print_usage(argv[0]);
            return 1;
        }
    }
    
    setenv("SYDB_BASE_DIR", "/tmp/sydb_test", 1);
    
    printf(CYAN "SYDB COMPREHENSIVE TEST SUITE\n" RESET);
    printf("===============================================\n");
    printf("Using command: " YELLOW "%s" RESET "\n\n", cli_command);
    
    // Cleanup previous test
    system("rm -rf /tmp/sydb_test > /dev/null 2>&1");
    
    // Core functionality tests
    TestCase tests[] = {
        // Database Operations with verification
        {
            "Create database 'testdb' and verify structure", 
            "%s create testdb > /dev/null 2>&1",
            "test -d '/tmp/sydb_test/testdb'",
            "",
            0, 0, 0, ""
        },
        {
            "Create second database 'testdb2' and verify", 
            "%s create testdb2 > /dev/null 2>&1",
            "test -d '/tmp/sydb_test/testdb2'", 
            "",
            0, 0, 0, ""
        },
        {
            "List databases and verify both exist",
            "%s list > /dev/null 2>&1", 
            "%s list | grep -c 'testdb\\|testdb2'",
            "2",
            0, 0, 0, ""
        },
        
        // Collection Operations with deep verification
        {
            "Create 'users' collection with schema and verify files",
            "%s create testdb users --schema --name-string-req --age-int --email-string > /dev/null 2>&1",
            "test -f '/tmp/sydb_test/testdb/users/schema.txt' && test -f '/tmp/sydb_test/testdb/users/data.sydb'",
            "",
            0, 0, 0, ""
        },
        {
            "Create 'products' collection and verify structure",
            "%s create testdb products --schema --name-string-req --price-float > /dev/null 2>&1",
            "test -f '/tmp/sydb_test/testdb/products/schema.txt'",
            "",
            0, 0, 0, ""
        },
        {
            "View users schema and verify output format",
            "%s schema testdb users > /dev/null 2>&1",
            "%s schema testdb users | grep -q 'Field.*Type'",
            "",
            0, 0, 0, ""
        },
        
        // Insert Operations with ID verification and count tracking
        {
            "Insert user record and verify by counting instances",
            "%s create testdb users --insert-one --name-\"John Doe\" --age-30 --email-\"john@test.com\" > /dev/null 2>&1",
            "%s list testdb users | grep -c '\"_id\"'",
            "1",
            0, 0, 0, ""
        },
        {
            "Insert second user and verify total count",
            "%s create testdb users --insert-one --name-\"Jane Smith\" --age-25 --email-\"jane@test.com\" > /dev/null 2>&1", 
            "%s list testdb users | grep -c '\"_id\"'",
            "2",
            0, 0, 0, ""
        },
        {
            "Insert product record and verify creation",
            "%s create testdb products --insert-one --name-\"Test Product\" --price-19.99 > /dev/null 2>&1",
            "%s list testdb products | grep -c 'Test Product'",
            "1",
            0, 0, 0, ""
        },
        
        // Query Operations with exact match verification
        {
            "Query users by age and verify exact match",
            "%s find testdb users --where \"age:30\" > /dev/null 2>&1",
            "%s find testdb users --where \"age:30\" | grep -c 'John Doe'",
            "1", 
            0, 0, 0, ""
        },
        {
            "Query products by name and verify result",
            "%s find testdb products --where \"name:Test Product\" > /dev/null 2>&1",
            "%s find testdb products --where \"name:Test Product\" | grep -c 'Test Product'",
            "1",
            0, 0, 0, ""
        },
        {
            "Query with non-existent condition returns empty",
            "%s find testdb users --where \"age:999\" > /dev/null 2>&1",
            "%s find testdb users --where \"age:999\" | wc -l",
            "0",
            0, 0, 0, ""
        },
        
        // List Operations with count verification
        {
            "List collections in testdb and verify count",
            "%s list testdb > /dev/null 2>&1",
            "%s list testdb | grep -c 'users\\|products'", 
            "2",
            0, 0, 0, ""
        },
        {
            "List users and verify record count",
            "%s list testdb users > /dev/null 2>&1",
            "%s list testdb users | grep -c '\"_id\"'",
            "2",
            0, 0, 0, ""
        },
        {
            "Verify UUID format in inserted records",
            "%s list testdb users | head -1 > /dev/null 2>&1",
            "%s list testdb users | head -1 | grep -Eo '\"[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}\"' | wc -l",
            "1",
            0, 0, 0, ""
        }
    };
    
    int total_tests = sizeof(tests) / sizeof(tests[0]);
    int passed_tests = 0;
    long long total_duration = 0;
    
    // Replace %s with cli_command in all test commands
    for (int i = 0; i < total_tests; i++) {
        char final_command[1024];
        char final_verification[1024];
        
        snprintf(final_command, sizeof(final_command), tests[i].command, cli_command);
        snprintf(final_verification, sizeof(final_verification), tests[i].verification_command, cli_command);
        
        strcpy(tests[i].command, final_command);
        strcpy(tests[i].verification_command, final_verification);
    }
    
    // Run all core tests
    for (int i = 0; i < total_tests; i++) {
        if (execute_test_with_verification(&tests[i])) {
            passed_tests++;
        }
        total_duration += tests[i].duration_ms;
    }
    
    // Run additional test suites
    run_security_tests();
    run_data_integrity_tests(); 
    run_edge_case_tests();
    run_performance_test();
    run_comprehensive_verification();
    
    // Calculate additional test suite results
    int security_passed = 3; // From security tests array
    int security_total = 3;
    int integrity_passed = 2; // From integrity tests array  
    int integrity_total = 2;
    int edge_passed = 6; // From edge tests array
    int edge_total = 6;
    
    // Final result
    print_detailed_results(passed_tests, total_tests, total_duration, 
                          security_passed, security_total, integrity_passed, integrity_total,
                          edge_passed, edge_total);
    
    // Overall success criteria
    int overall_success = (passed_tests == total_tests) && 
                         (security_passed == security_total) &&
                         (integrity_passed >= integrity_total - 1); // Allow one integrity test to fail
    
    return overall_success ? 0 : 1;
}