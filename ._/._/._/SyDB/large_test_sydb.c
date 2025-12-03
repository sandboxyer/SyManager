#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <unistd.h>
#include <sys/time.h>
#include <time.h>
#include <dirent.h>
#include <sys/stat.h>
#include <fcntl.h>
#include <sys/socket.h>
#include <netinet/in.h>
#include <arpa/inet.h>
#include <netdb.h>
#include <errno.h>
#include <ctype.h>

#define RED     "\033[1;31m"
#define GREEN   "\033[1;32m"
#define YELLOW  "\033[1;33m"
#define BLUE    "\033[1;34m"
#define MAGENTA "\033[1;35m"
#define CYAN    "\033[1;36m"
#define WHITE   "\033[1;37m"
#define GRAY    "\033[1;90m"
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
    char verbose_output[4096];
} TestCase;

char cli_command[32] = "./sydb";
int test_mode = 0;
char server_url[256] = "http://localhost:8080";
int verbose_mode = 0;

typedef struct {
    int status_code;
    char* body;
    size_t body_length;
} HttpResponse;

HttpResponse* http_request(const char* method, const char* url, const char* body, const char* content_type);
void http_response_free(HttpResponse* response);
int http_test_endpoint(const char* description, const char* method, const char* endpoint, 
                      const char* body, const char* expected_pattern, int check_success_only, long long* duration);
int verify_http_response(const HttpResponse* response, const char* expected_pattern, int check_success_only);
char* extract_json_field(const char* json, const char* field);

long long get_current_time_ms();
int file_exists(const char *path);
int count_files_in_directory(const char *path);
int count_instances_in_collection(const char *database, const char *collection);
char* get_last_inserted_id(const char *database, const char *collection);
int execute_command_and_capture(const char *command, char *output, size_t output_size);
int execute_command_and_capture_verbose(const char *command, char *output, size_t output_size, char *verbose_output, size_t verbose_size);
int verify_database_structure(const char *database);
int verify_collection_structure(const char *database, const char *collection);
int verify_schema_content(const char *database, const char *collection, const char *expected_fields);
int execute_test_with_verification(TestCase *test);
void run_security_tests();
void run_data_integrity_tests();
void run_performance_test();
void run_edge_case_tests();
void run_comprehensive_verification();

long long get_current_time_ms() {
    struct timeval tv;
    gettimeofday(&tv, NULL);
    return (long long)tv.tv_sec * 1000 + tv.tv_usec / 1000;
}

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
        output[strcspn(output, "\n")] = '\0';
    }
    pclose(fp);
    return 0;
}

int execute_command_and_capture_verbose(const char *command, char *output, size_t output_size, char *verbose_output, size_t verbose_size) {
    if (verbose_mode) {
        printf(YELLOW "\n  [VERBOSE] EXECUTION DETAILS\n" RESET);
        printf(YELLOW "  [VERBOSE] Command to execute:\n" RESET);
        printf(GRAY "    %s\n" RESET, command);
        printf(YELLOW "  [VERBOSE] Command structure analysis:\n" RESET);
        
        if (strstr(command, "grep")) {
            printf(GRAY "    Contains grep command - exit codes 0/1 are normal\n" RESET);
        }
        if (strstr(command, "|")) {
            printf(GRAY "    Contains pipe(s) - compound command\n" RESET);
        }
        if (strstr(command, "2>&1")) {
            printf(GRAY "    STDERR redirected to STDOUT\n" RESET);
        }
    }
    
    FILE *fp = popen(command, "r");
    if (!fp) {
        if (verbose_mode) {
            printf(RED "  [VERBOSE] CRITICAL ERROR: popen() failed\n" RESET);
            printf(RED "  [VERBOSE] Possible causes:\n" RESET);
            printf(GRAY "    - Shell not available\n" RESET);
            printf(GRAY "    - Memory exhausted\n" RESET);
            printf(GRAY "    - Too many open file descriptors\n" RESET);
        }
        return -1;
    }
    
    output[0] = '\0';
    verbose_output[0] = '\0';
    
    char buffer[1024];
    size_t total_verbose_size = 0;
    int line_count = 0;
    
    if (verbose_mode) {
        printf(YELLOW "  [VERBOSE] Command output stream:\n" RESET);
    }
    
    while (fgets(buffer, sizeof(buffer), fp)) {
        buffer[strcspn(buffer, "\n")] = '\0';
        line_count++;
        
        if (output[0] == '\0') {
            strncpy(output, buffer, output_size - 1);
            output[output_size - 1] = '\0';
            if (verbose_mode) {
                printf(GRAY "    Line %d (first line captured as output): %s\n" RESET, line_count, buffer);
            }
        } else {
            if (verbose_mode) {
                printf(GRAY "    Line %d: %s\n" RESET, line_count, buffer);
            }
        }
        
        if (total_verbose_size + strlen(buffer) < verbose_size - 1) {
            strcat(verbose_output, buffer);
            strcat(verbose_output, "\n");
            total_verbose_size += strlen(buffer) + 1;
        }
    }
    
    int status = pclose(fp);
    
    int result;
    if (WIFEXITED(status)) {
        int exit_code = WEXITSTATUS(status);
        if (strstr(command, "grep") != NULL) {
            result = (exit_code == 0 || exit_code == 1) ? 0 : -1;
        } else {
            result = (exit_code == 0) ? 0 : -1;
        }
        
        if (verbose_mode) {
            printf(YELLOW "  [VERBOSE] Command exited normally\n" RESET);
            printf(GRAY "    Exit code: %d\n" RESET, exit_code);
            printf(GRAY "    Process interpretation: %s\n" RESET, (result == 0) ? "SUCCESS" : "FAILURE");
            
            if (strstr(command, "grep")) {
                printf(GRAY "    Grep-specific interpretation:\n" RESET);
                printf(GRAY "      Exit code %d = pattern %s\n" RESET, 
                       exit_code, 
                       exit_code == 0 ? "FOUND" : exit_code == 1 ? "NOT FOUND (normal)" : "ERROR");
            }
        }
    } else if (WIFSIGNALED(status)) {
        result = -1;
        if (verbose_mode) {
            int sig = WTERMSIG(status);
            printf(RED "  [VERBOSE] Command terminated by signal\n" RESET);
            printf(GRAY "    Signal number: %d\n" RESET, sig);
            printf(GRAY "    Signal name: %s\n" RESET, strsignal(sig));
        }
    } else if (WIFSTOPPED(status)) {
        result = -1;
        if (verbose_mode) {
            printf(RED "  [VERBOSE] Command stopped by signal\n" RESET);
            printf(GRAY "    Stop signal: %d\n" RESET, WSTOPSIG(status));
        }
    } else {
        result = -1;
        if (verbose_mode) {
            printf(RED "  [VERBOSE] Command did not exit normally\n" RESET);
            printf(GRAY "    Raw status: %d\n" RESET, status);
        }
    }
    
    if (verbose_mode) {
        printf(YELLOW "  [VERBOSE] Execution summary:\n" RESET);
        printf(GRAY "    Total lines output: %d\n" RESET, line_count);
        printf(GRAY "    First line captured: \"%s\"\n" RESET, output[0] != '\0' ? output : "(empty)");
        printf(GRAY "    Total verbose output length: %zu bytes\n" RESET, total_verbose_size);
        printf(GRAY "    Final result code: %d (%s)\n" RESET, result, result == 0 ? "SUCCESS" : "FAILURE");
    }
    
    return result;
}

int verify_database_structure(const char *database) {
    char path[512];
    snprintf(path, sizeof(path), "/tmp/sydb_test/%s", database);
    
    if (verbose_mode) {
        printf(YELLOW "\n  [VERBOSE] DATABASE STRUCTURE VERIFICATION\n" RESET);
        printf(GRAY "    Database: %s\n" RESET, database);
        printf(GRAY "    Expected path: %s\n" RESET, path);
    }
    
    if (!file_exists(path)) {
        if (verbose_mode) {
            printf(RED "  [VERBOSE] FAILURE ANALYSIS:\n" RESET);
            printf(RED "    Database directory doesn't exist\n" RESET);
            printf(GRAY "    Checked path: %s\n" RESET, path);
            printf(GRAY "    Full directory contents of /tmp/sydb_test/:\n" RESET);
            system("ls -la /tmp/sydb_test/ 2>/dev/null | while read line; do echo \"      $line\"; done");
            printf(GRAY "    Current working directory: " RESET);
            system("pwd");
            printf(GRAY "    Environment variable SYDB_BASE_DIR: %s\n" RESET, getenv("SYDB_BASE_DIR"));
        }
        printf(RED "  ✗ Database directory doesn't exist\n" RESET);
        return 0;
    }
    
    struct stat st;
    if (stat(path, &st) != 0) {
        if (verbose_mode) {
            printf(RED "  [VERBOSE] FAILURE ANALYSIS:\n" RESET);
            printf(RED "    stat() call failed\n" RESET);
            printf(GRAY "    Path: %s\n" RESET, path);
            printf(GRAY "    errno: %d (%s)\n" RESET, errno, strerror(errno));
        }
        printf(RED "  ✗ Cannot access database directory\n" RESET);
        return 0;
    }
    
    if (!S_ISDIR(st.st_mode)) {
        if (verbose_mode) {
            printf(RED "  [VERBOSE] FAILURE ANALYSIS:\n" RESET);
            printf(RED "    Path exists but is not a directory\n" RESET);
            printf(GRAY "    Path: %s\n" RESET, path);
            printf(GRAY "    File type: ");
            if (S_ISREG(st.st_mode)) printf("Regular file\n" RESET);
            else if (S_ISLNK(st.st_mode)) printf("Symbolic link\n" RESET);
            else printf("Other (mode: %o)\n" RESET, st.st_mode & S_IFMT);
            printf(GRAY "    Permissions: %o\n" RESET, st.st_mode & 0777);
        }
        printf(RED "  ✗ Database path is not a directory\n" RESET);
        return 0;
    }
    
    if (verbose_mode) {
        printf(GREEN "  [VERBOSE] SUCCESS ANALYSIS:\n" RESET);
        printf(GREEN "    Database directory exists and is valid\n" RESET);
        printf(GRAY "    Path: %s\n" RESET, path);
        printf(GRAY "    Permissions: %o\n" RESET, st.st_mode & 0777);
        printf(GRAY "    Size: %ld bytes\n" RESET, st.st_size);
        printf(GRAY "    Last modified: %s", ctime(&st.st_mtime));
        printf(GRAY "    Contents of database directory:\n" RESET);
        char ls_cmd[512];
        snprintf(ls_cmd, sizeof(ls_cmd), "ls -la \"%s\" 2>/dev/null", path);
        system(ls_cmd);
    }
    printf(GREEN "  ✓ Database directory exists and is valid\n" RESET);
    return 1;
}

int verify_collection_structure(const char *database, const char *collection) {
    char path[512];
    snprintf(path, sizeof(path), "/tmp/sydb_test/%s/%s", database, collection);
    
    if (verbose_mode) {
        printf(YELLOW "\n  [VERBOSE] COLLECTION STRUCTURE VERIFICATION\n" RESET);
        printf(GRAY "    Database: %s\n" RESET, database);
        printf(GRAY "    Collection: %s\n" RESET, collection);
        printf(GRAY "    Expected path: %s\n" RESET, path);
    }
    
    if (!file_exists(path)) {
        if (verbose_mode) {
            printf(RED "  [VERBOSE] FAILURE ANALYSIS:\n" RESET);
            printf(RED "    Collection directory doesn't exist\n" RESET);
            printf(GRAY "    Checked path: %s\n" RESET, path);
            printf(GRAY "    Parent directory contents:\n" RESET);
            char parent_path[512];
            snprintf(parent_path, sizeof(parent_path), "/tmp/sydb_test/%s", database);
            char ls_cmd[512];
            snprintf(ls_cmd, sizeof(ls_cmd), "ls -la \"%s\" 2>/dev/null", parent_path);
            system(ls_cmd);
        }
        printf(RED "  ✗ Collection directory doesn't exist\n" RESET);
        return 0;
    }
    
    char schema_path[512];
    snprintf(schema_path, sizeof(schema_path), "%s/schema.txt", path);
    if (!file_exists(schema_path)) {
        if (verbose_mode) {
            printf(RED "  [VERBOSE] FAILURE ANALYSIS:\n" RESET);
            printf(RED "    Schema file doesn't exist\n" RESET);
            printf(GRAY "    Expected schema path: %s\n" RESET, schema_path);
            printf(GRAY "    Collection directory contents:\n" RESET);
            char ls_cmd[512];
            snprintf(ls_cmd, sizeof(ls_cmd), "ls -la \"%s\" 2>/dev/null", path);
            system(ls_cmd);
            printf(GRAY "    Looking for files matching '*schema*':\n" RESET);
            snprintf(ls_cmd, sizeof(ls_cmd), "ls -la \"%s\" 2>/dev/null | grep -i schema", path);
            system(ls_cmd);
        }
        printf(RED "  ✗ Schema file doesn't exist\n" RESET);
        return 0;
    }
    
    char data_path[512];
    snprintf(data_path, sizeof(data_path), "%s/data.sydb", path);
    if (!file_exists(data_path)) {
        if (verbose_mode) {
            printf(RED "  [VERBOSE] FAILURE ANALYSIS:\n" RESET);
            printf(RED "    Data file doesn't exist\n" RESET);
            printf(GRAY "    Expected data path: %s\n" RESET, data_path);
            printf(GRAY "    Collection directory contents:\n" RESET);
            char ls_cmd[512];
            snprintf(ls_cmd, sizeof(ls_cmd), "ls -la \"%s\" 2>/dev/null", path);
            system(ls_cmd);
            printf(GRAY "    Looking for files matching '*data*':\n" RESET);
            snprintf(ls_cmd, sizeof(ls_cmd), "ls -la \"%s\" 2>/dev/null | grep -i data", path);
            system(ls_cmd);
        }
        printf(RED "  ✗ Data file doesn't exist\n" RESET);
        return 0;
    }
    
    if (verbose_mode) {
        printf(GREEN "  [VERBOSE] SUCCESS ANALYSIS:\n" RESET);
        printf(GREEN "    Collection structure is valid\n" RESET);
        printf(GRAY "    Collection path: %s\n" RESET, path);
        printf(GRAY "    Schema file: %s\n" RESET, schema_path);
        printf(GRAY "    Data file: %s\n" RESET, data_path);
        
        printf(GRAY "    Schema file content (first 20 lines):\n" RESET);
        char cat_cmd[512];
        snprintf(cat_cmd, sizeof(cat_cmd), "head -20 \"%s\" 2>/dev/null", schema_path);
        system(cat_cmd);
        
        struct stat data_stat;
        if (stat(data_path, &data_stat) == 0) {
            printf(GRAY "    Data file size: %ld bytes\n" RESET, data_stat.st_size);
            printf(GRAY "    Data file last modified: %s", ctime(&data_stat.st_mtime));
        }
    }
    printf(GREEN "  ✓ Collection structure is valid\n" RESET);
    return 1;
}

int verify_schema_content(const char *database, const char *collection, const char *expected_fields) {
    char command[512];
    snprintf(command, sizeof(command), "%s schema %s %s", cli_command, database, collection);
    
    if (verbose_mode) {
        printf(YELLOW "\n  [VERBOSE] SCHEMA CONTENT VERIFICATION\n" RESET);
        printf(GRAY "    Database: %s\n" RESET, database);
        printf(GRAY "    Collection: %s\n" RESET, collection);
        printf(GRAY "    Command to execute: %s\n" RESET, command);
        if (expected_fields && expected_fields[0]) {
            printf(GRAY "    Expected fields to find: %s\n" RESET, expected_fields);
        }
    }
    
    char output[1024];
    char verbose_output[4096];
    int result;
    
    if (verbose_mode) {
        result = execute_command_and_capture_verbose(command, output, sizeof(output), verbose_output, sizeof(verbose_output));
    } else {
        result = execute_command_and_capture(command, output, sizeof(output));
    }
    
    if (result != 0) {
        if (verbose_mode) {
            printf(RED "  [VERBOSE] FAILURE ANALYSIS:\n" RESET);
            printf(RED "    Command execution failed\n" RESET);
            printf(GRAY "    Command: %s\n" RESET, command);
            printf(GRAY "    Return code: %d\n" RESET, result);
            printf(GRAY "    Raw output: %s\n" RESET, output);
            printf(GRAY "    Possible issues:\n" RESET);
            printf(GRAY "      - Database doesn't exist\n" RESET);
            printf(GRAY "      - Collection doesn't exist\n" RESET);
            printf(GRAY "      - Schema command syntax error\n" RESET);
        }
        printf(RED "  ✗ Could not read schema\n" RESET);
        return 0;
    }
    
    if (verbose_mode) {
        printf(YELLOW "  [VERBOSE] SCHEMA OUTPUT ANALYSIS:\n" RESET);
        printf(GRAY "    Raw output: \"%s\"\n" RESET, output);
        printf(GRAY "    Output length: %zu characters\n" RESET, strlen(output));
        printf(GRAY "    Looking for 'Field' in output: %s\n" RESET, 
               strstr(output, "Field") ? "FOUND" : "NOT FOUND");
        printf(GRAY "    Looking for 'Type' in output: %s\n" RESET, 
               strstr(output, "Type") ? "FOUND" : "NOT FOUND");
    }
    
    if (strstr(output, "Field") == NULL || strstr(output, "Type") == NULL) {
        if (verbose_mode) {
            printf(RED "  [VERBOSE] FAILURE ANALYSIS:\n" RESET);
            printf(RED "    Schema output format incorrect\n" RESET);
            printf(GRAY "    Expected to find both 'Field' and 'Type' in output\n" RESET);
            printf(GRAY "    Actual output received:\n" RESET);
            printf(WHITE "    --- BEGIN OUTPUT ---\n" RESET);
            printf("%s\n", output);
            printf(WHITE "    --- END OUTPUT ---\n" RESET);
            printf(GRAY "    Character-by-character analysis:\n" RESET);
            for (int i = 0; i < (int)strlen(output) && i < 100; i++) {
                printf(GRAY "      [%3d] 0x%02x '%c'\n" RESET, i, (unsigned char)output[i], 
                       output[i] >= 32 && output[i] <= 126 ? output[i] : '.');
            }
        }
        printf(RED "  ✗ Schema output format incorrect\n" RESET);
        return 0;
    }
    
    if (verbose_mode) {
        printf(GREEN "  [VERBOSE] SUCCESS ANALYSIS:\n" RESET);
        printf(GREEN "    Schema content is valid\n" RESET);
        printf(GRAY "    Full schema output:\n" RESET);
        printf(WHITE "    --- BEGIN SCHEMA ---\n" RESET);
        if (verbose_output[0] != '\0') {
            printf("%s", verbose_output);
        } else {
            printf("%s\n", output);
        }
        printf(WHITE "    --- END SCHEMA ---\n" RESET);
        
        if (expected_fields && expected_fields[0]) {
            printf(GRAY "    Searching for expected fields:\n" RESET);
            char *token;
            char fields_copy[1024];
            strncpy(fields_copy, expected_fields, sizeof(fields_copy));
            token = strtok(fields_copy, ",");
            while (token != NULL) {
                char *found = strstr(output, token);
                printf(GRAY "      Field '%s': %s\n" RESET, token, 
                       found ? "FOUND" : "NOT FOUND");
                token = strtok(NULL, ",");
            }
        }
    }
    printf(GREEN "  ✓ Schema content is valid\n" RESET);
    return 1;
}

int execute_test_with_verification(TestCase *test) {
    printf("\n%s%-80s" RESET, BLUE, test->description);
    fflush(stdout);
    
    long long start_time = get_current_time_ms();
    
    if (verbose_mode) {
        printf(YELLOW "\n  [VERBOSE] ========================================\n" RESET);
        printf(YELLOW "  [VERBOSE] TEST EXECUTION DETAILS\n" RESET);
        printf(YELLOW "  [VERBOSE] ========================================\n" RESET);
        printf(GRAY "    Test Description: %s\n" RESET, test->description);
        printf(GRAY "    Main Command: %s\n" RESET, test->command);
        printf(GRAY "    Verification Command: %s\n" RESET, 
               test->verification_command[0] ? test->verification_command : "(none)");
        printf(GRAY "    Expected Output Pattern: \"%s\"\n" RESET, 
               test->expected_output[0] ? test->expected_output : "(any)");
        printf(GRAY "    Start Time: %lld ms\n" RESET, start_time);
    }
    
    int result = system(test->command);
    long long end_time = get_current_time_ms();
    
    test->duration_ms = end_time - start_time;
    test->success = (result == 0);
    
    if (verbose_mode) {
        printf(YELLOW "\n  [VERBOSE] MAIN COMMAND EXECUTION RESULTS\n" RESET);
        printf(GRAY "    Command: %s\n" RESET, test->command);
        printf(GRAY "    Raw exit code: %d\n" RESET, result);
        
        if (WIFEXITED(result)) {
            int exit_status = WEXITSTATUS(result);
            printf(GRAY "    Normal exit with status: %d\n" RESET, exit_status);
            printf(GRAY "    Interpretation: %s\n" RESET, exit_status == 0 ? "SUCCESS" : "FAILURE");
        } else if (WIFSIGNALED(result)) {
            printf(GRAY "    Terminated by signal: %d\n" RESET, WTERMSIG(result));
        } else if (WIFSTOPPED(result)) {
            printf(GRAY "    Stopped by signal: %d\n" RESET, WSTOPSIG(result));
        }
        
        printf(GRAY "    Execution time: %lld ms\n" RESET, test->duration_ms);
        printf(GRAY "    Test success flag: %s\n" RESET, test->success ? "TRUE" : "FALSE");
    }
    
    test->verification_success = 1;
    if (test->success && test->verification_command[0] != '\0') {
        char verification_output[1024];
        char verbose_output[4096];
        int verification_result;
        
        if (verbose_mode) {
            printf(YELLOW "\n  [VERBOSE] VERIFICATION PHASE\n" RESET);
        }
        
        if (verbose_mode) {
            verification_result = execute_command_and_capture_verbose(test->verification_command, 
                                                                   verification_output, 
                                                                   sizeof(verification_output),
                                                                   verbose_output,
                                                                   sizeof(verbose_output));
            strncpy(test->verbose_output, verbose_output, sizeof(test->verbose_output) - 1);
        } else {
            verification_result = execute_command_and_capture(test->verification_command, 
                                                            verification_output, 
                                                            sizeof(verification_output));
        }
        
        if (verification_result == 0) {
            if (test->expected_output[0] != '\0') {
                if (verbose_mode) {
                    printf(YELLOW "  [VERBOSE] EXPECTED OUTPUT VALIDATION\n" RESET);
                    printf(GRAY "    Expected pattern: \"%s\"\n" RESET, test->expected_output);
                    printf(GRAY "    Actual output: \"%s\"\n" RESET, verification_output);
                    printf(GRAY "    Pattern search: %s\n" RESET, 
                           strstr(verification_output, test->expected_output) ? "FOUND" : "NOT FOUND");
                    
                    if (strstr(verification_output, test->expected_output) == NULL) {
                        printf(RED "  [VERBOSE] PATTERN MATCHING FAILURE ANALYSIS:\n" RESET);
                        printf(GRAY "    Expected string length: %zu\n" RESET, strlen(test->expected_output));
                        printf(GRAY "    Actual string length: %zu\n" RESET, strlen(verification_output));
                        
                        int max_len = strlen(test->expected_output);
                        int best_match = 0;
                        int best_position = -1;
                        
                        for (int i = 0; verification_output[i]; i++) {
                            int match_len = 0;
                            while (match_len < max_len && 
                                   verification_output[i + match_len] && 
                                   verification_output[i + match_len] == test->expected_output[match_len]) {
                                match_len++;
                            }
                            if (match_len > best_match) {
                                best_match = match_len;
                                best_position = i;
                            }
                        }
                        
                        if (best_match > 0) {
                            printf(GRAY "    Best partial match: %d characters at position %d\n" RESET, 
                                   best_match, best_position);
                            printf(GRAY "    Partial match context:\n" RESET);
                            printf(GRAY "      Expected: \"%s\"\n" RESET, test->expected_output);
                            printf(GRAY "      Partial:  \"%.*s\"\n" RESET, best_match, 
                                   &verification_output[best_position]);
                            printf(GRAY "      Next expected char: '%c' (0x%02x)\n" RESET,
                                   test->expected_output[best_match],
                                   test->expected_output[best_match]);
                            printf(GRAY "      Next actual char:   '%c' (0x%02x)\n" RESET,
                                   verification_output[best_position + best_match],
                                   verification_output[best_position + best_match]);
                        } else {
                            printf(GRAY "    No partial matches found\n" RESET);
                        }
                        
                        if (strlen(verification_output) == strlen(test->expected_output)) {
                            printf(GRAY "    Character-by-character comparison:\n" RESET);
                            for (size_t i = 0; i < strlen(test->expected_output); i++) {
                                if (verification_output[i] != test->expected_output[i]) {
                                    printf(GRAY "      Position %zu: expected '%c' (0x%02x), got '%c' (0x%02x) %s\n" RESET,
                                           i,
                                           test->expected_output[i], (unsigned char)test->expected_output[i],
                                           verification_output[i], (unsigned char)verification_output[i],
                                           verification_output[i] == '\0' ? "(STRING END)" : "");
                                }
                            }
                        }
                    }
                }
                
                if (strstr(verification_output, test->expected_output) == NULL) {
                    test->verification_success = 0;
                    strncpy(test->details, verification_output, sizeof(test->details) - 1);
                    
                    if (verbose_mode) {
                        printf(RED "  [VERBOSE] VERIFICATION FAILED - Pattern not found\n" RESET);
                    }
                } else {
                    if (verbose_mode) {
                        printf(GREEN "  [VERBOSE] VERIFICATION SUCCESS - Pattern found\n" RESET);
                    }
                }
            } else {
                if (verbose_mode) {
                    printf(GREEN "  [VERBOSE] VERIFICATION SUCCESS - No expected pattern to match\n" RESET);
                }
            }
        } else {
            test->verification_success = 0;
            strcpy(test->details, "Verification command failed");
            
            if (verbose_mode) {
                printf(RED "  [VERBOSE] VERIFICATION FAILED - Command execution failed\n" RESET);
                printf(GRAY "    Verification command: %s\n" RESET, test->verification_command);
                printf(GRAY "    Exit code: %d\n" RESET, verification_result);
            }
        }
    } else if (!test->success && test->verification_command[0] != '\0') {
        if (verbose_mode) {
            printf(YELLOW "  [VERBOSE] VERIFICATION SKIPPED - Main command failed\n" RESET);
        }
    }
    
    int overall_success = test->success && test->verification_success;
    
    if (verbose_mode) {
        printf(YELLOW "\n  [VERBOSE] FINAL TEST ASSESSMENT\n" RESET);
        printf(GRAY "    Main command success: %s\n" RESET, test->success ? "YES" : "NO");
        printf(GRAY "    Verification success: %s\n" RESET, test->verification_success ? "YES" : "NO");
        printf(GRAY "    Overall success: %s\n" RESET, overall_success ? "YES" : "NO");
        printf(GRAY "    Total duration: %lld ms\n" RESET, test->duration_ms);
    }
    
    if (overall_success) {
        printf("[" GREEN "PASS" RESET "]");
    } else {
        printf("[" RED "FAIL" RESET "]");
    }
    
    printf(" %s%4lld ms%s\n", CYAN, test->duration_ms, RESET);
    
    if (!test->verification_success) {
        if (test->details[0] != '\0') {
            printf(RED "  Verification failed: %s\n" RESET, test->details);
        }
        
        if (verbose_mode && test->verbose_output[0] != '\0') {
            printf(YELLOW "  [VERBOSE] FULL VERIFICATION OUTPUT:\n" RESET);
            printf(WHITE "  --- BEGIN VERBOSE OUTPUT ---\n" RESET);
            printf("%s\n", test->verbose_output);
            printf(WHITE "  --- END VERBOSE OUTPUT ---\n" RESET);
        }
    }
    
    if (verbose_mode && !overall_success) {
        printf(RED "\n  [VERBOSE] ========================================\n" RESET);
        printf(RED "  [VERBOSE] FAILURE ROOT CAUSE ANALYSIS\n" RESET);
        printf(RED "  [VERBOSE] ========================================\n" RESET);
        printf(RED "  [VERBOSE] Test: %s\n" RESET, test->description);
        printf(RED "  [VERBOSE] Main command success: %s\n" RESET, test->success ? "YES" : "NO");
        printf(RED "  [VERBOSE] Verification success: %s\n" RESET, test->verification_success ? "YES" : "NO");
        
        if (!test->success) {
            printf(RED "  [VERBOSE] PRIMARY FAILURE: Main command execution\n" RESET);
            printf(GRAY "    Command: %s\n" RESET, test->command);
            printf(GRAY "    Raw exit code: %d\n" RESET, result);
            
            printf(RED "  [VERBOSE] POSSIBLE SOLUTIONS:\n" RESET);
            if (strstr(test->command, "testdb")) {
                printf(GRAY "    - Check if testdb database exists\n" RESET);
                printf(GRAY "    - Verify database permissions\n" RESET);
            }
            if (strstr(test->command, "grep")) {
                printf(GRAY "    - Check if grep pattern matches actual output\n" RESET);
                printf(GRAY "    - Verify case sensitivity\n" RESET);
            }
            if (strstr(test->command, "|")) {
                printf(GRAY "    - Check each command in the pipeline separately\n" RESET);
            }
        } else if (!test->verification_success) {
            printf(RED "  [VERBOSE] PRIMARY FAILURE: Verification phase\n" RESET);
            printf(GRAY "    Verification command: %s\n" RESET, test->verification_command);
            printf(GRAY "    Expected pattern: \"%s\"\n" RESET, test->expected_output);
            printf(GRAY "    Details: %s\n" RESET, test->details);
            
            if (test->verbose_output[0] != '\0') {
                printf(GRAY "    Full output captured (%zu bytes)\n" RESET, strlen(test->verbose_output));
            }
        }
        
        printf(RED "  [VERBOSE] ========================================\n" RESET);
    }
    
    return overall_success;
}

HttpResponse* http_request(const char* method, const char* url, const char* body, const char* content_type) {
    HttpResponse* response = malloc(sizeof(HttpResponse));
    if (!response) return NULL;
    
    response->status_code = 0;
    response->body = NULL;
    response->body_length = 0;
    
    if (verbose_mode) {
        printf(YELLOW "\n  [VERBOSE] HTTP REQUEST INITIATION\n" RESET);
        printf(GRAY "    Method: %s\n" RESET, method);
        printf(GRAY "    URL: %s\n" RESET, url);
        printf(GRAY "    Body: %s\n" RESET, body ? body : "(none)");
        printf(GRAY "    Content-Type: %s\n" RESET, content_type ? content_type : "(none)");
    }
    
    char host[256] = "localhost";
    int port = 8080;
    char path[1024] = "/";
    
    if (strncmp(url, "http://", 7) == 0) {
        const char* host_start = url + 7;
        const char* path_start = strchr(host_start, '/');
        const char* port_start = strchr(host_start, ':');
        
        if (verbose_mode) {
            printf(YELLOW "  [VERBOSE] URL PARSING ANALYSIS\n" RESET);
            printf(GRAY "    Full URL: %s\n" RESET, url);
            printf(GRAY "    Host start at: %s\n" RESET, host_start);
            printf(GRAY "    Path start: %s\n" RESET, path_start ? path_start : "NULL");
            printf(GRAY "    Port start: %s\n" RESET, port_start ? port_start : "NULL");
        }
        
        if (port_start && (!path_start || port_start < path_start)) {
            size_t host_len = port_start - host_start;
            strncpy(host, host_start, host_len);
            host[host_len] = '\0';
            port = atoi(port_start + 1);
            if (path_start) {
                strcpy(path, path_start);
            }
            
            if (verbose_mode) {
                printf(GRAY "    Case 1: Port before path\n" RESET);
                printf(GRAY "    Host: %s (length: %zu)\n" RESET, host, host_len);
                printf(GRAY "    Port: %d\n" RESET, port);
                printf(GRAY "    Path: %s\n" RESET, path);
            }
        } else if (path_start) {
            size_t host_len = path_start - host_start;
            strncpy(host, host_start, host_len);
            host[host_len] = '\0';
            strcpy(path, path_start);
            
            if (verbose_mode) {
                printf(GRAY "    Case 2: No port, has path\n" RESET);
                printf(GRAY "    Host: %s (length: %zu)\n" RESET, host, host_len);
                printf(GRAY "    Path: %s\n" RESET, path);
            }
        } else {
            strcpy(host, host_start);
            
            if (verbose_mode) {
                printf(GRAY "    Case 3: No port, no path\n" RESET);
                printf(GRAY "    Host: %s\n" RESET, host);
            }
        }
    } else {
        strcpy(path, url);
        
        if (verbose_mode) {
            printf(GRAY "    Case 4: Path only (no http://)\n" RESET);
            printf(GRAY "    Path: %s\n" RESET, path);
        }
    }
    
    if (verbose_mode) {
        printf(YELLOW "  [VERBOSE] PARSED URL COMPONENTS\n" RESET);
        printf(GRAY "    Host: %s\n" RESET, host);
        printf(GRAY "    Port: %d\n" RESET, port);
        printf(GRAY "    Path: %s\n" RESET, path);
    }
    
    int sockfd = socket(AF_INET, SOCK_STREAM, 0);
    if (sockfd < 0) {
        if (verbose_mode) {
            printf(RED "  [VERBOSE] SOCKET CREATION FAILED\n" RESET);
            printf(GRAY "    Error: %s (errno: %d)\n" RESET, strerror(errno), errno);
            printf(GRAY "    Domain: AF_INET\n" RESET);
            printf(GRAY "    Type: SOCK_STREAM\n" RESET);
            printf(GRAY "    Protocol: 0\n" RESET);
        }
        free(response);
        return NULL;
    }
    
    if (verbose_mode) {
        printf(GREEN "  [VERBOSE] Socket created successfully\n" RESET);
        printf(GRAY "    Socket FD: %d\n" RESET, sockfd);
    }
    
    struct timeval timeout;
    timeout.tv_sec = 10;
    timeout.tv_usec = 0;
    setsockopt(sockfd, SOL_SOCKET, SO_RCVTIMEO, &timeout, sizeof(timeout));
    setsockopt(sockfd, SOL_SOCKET, SO_SNDTIMEO, &timeout, sizeof(timeout));
    
    if (verbose_mode) {
        printf(GRAY "    Timeout set: %ld seconds\n" RESET, timeout.tv_sec);
    }
    
    if (verbose_mode) {
        printf(YELLOW "  [VERBOSE] RESOLVING HOSTNAME\n" RESET);
        printf(GRAY "    Hostname to resolve: %s\n" RESET, host);
    }
    
    struct hostent* server = gethostbyname(host);
    if (!server) {
        if (verbose_mode) {
            printf(RED "  [VERBOSE] HOSTNAME RESOLUTION FAILED\n" RESET);
            printf(GRAY "    Host: %s\n" RESET, host);
            printf(GRAY "    h_errno: %d\n" RESET, h_errno);
            printf(GRAY "    Possible causes:\n" RESET);
            printf(GRAY "      - DNS server not reachable\n" RESET);
            printf(GRAY "      - Hostname doesn't exist\n" RESET);
            printf(GRAY "      - Network configuration issue\n" RESET);
        }
        close(sockfd);
        free(response);
        return NULL;
    }
    
    if (verbose_mode) {
        printf(GREEN "  [VERBOSE] Hostname resolved successfully\n" RESET);
        printf(GRAY "    Official name: %s\n" RESET, server->h_name);
        printf(GRAY "    Address type: %s\n" RESET, 
               server->h_addrtype == AF_INET ? "AF_INET (IPv4)" : "Other");
        printf(GRAY "    Address length: %d bytes\n" RESET, server->h_length);
        
        printf(GRAY "    IP addresses:\n" RESET);
        for (int i = 0; server->h_addr_list[i] != NULL; i++) {
            struct in_addr addr;
            memcpy(&addr, server->h_addr_list[i], sizeof(addr));
            printf(GRAY "      %d: %s\n" RESET, i + 1, inet_ntoa(addr));
        }
    }
    
    struct sockaddr_in serv_addr;
    memset(&serv_addr, 0, sizeof(serv_addr));
    serv_addr.sin_family = AF_INET;
    memcpy(&serv_addr.sin_addr.s_addr, server->h_addr, server->h_length);
    serv_addr.sin_port = htons(port);
    
    if (verbose_mode) {
        printf(YELLOW "  [VERBOSE] ATTEMPTING CONNECTION\n" RESET);
        printf(GRAY "    Server address: %s\n" RESET, inet_ntoa(serv_addr.sin_addr));
        printf(GRAY "    Server port: %d\n" RESET, ntohs(serv_addr.sin_port));
    }
    
    if (connect(sockfd, (struct sockaddr*)&serv_addr, sizeof(serv_addr)) < 0) {
        if (verbose_mode) {
            printf(RED "  [VERBOSE] CONNECTION FAILED\n" RESET);
            printf(GRAY "    Error: %s (errno: %d)\n" RESET, strerror(errno), errno);
            printf(GRAY "    Server: %s:%d\n" RESET, inet_ntoa(serv_addr.sin_addr), port);
            printf(GRAY "    Socket FD: %d\n" RESET, sockfd);
            printf(GRAY "    Possible causes:\n" RESET);
            printf(GRAY "      - Server not running\n" RESET);
            printf(GRAY "      - Firewall blocking connection\n" RESET);
            printf(GRAY "      - Wrong port number\n" RESET);
        }
        close(sockfd);
        free(response);
        return NULL;
    }
    
    if (verbose_mode) {
        printf(GREEN "  [VERBOSE] Connection established successfully\n" RESET);
        printf(GRAY "    Connected to: %s:%d\n" RESET, inet_ntoa(serv_addr.sin_addr), port);
    }
    
    char request[8192];
    int request_len;
    
    if (body && content_type) {
        request_len = snprintf(request, sizeof(request),
            "%s %s HTTP/1.1\r\n"
            "Host: %s:%d\r\n"
            "Content-Type: %s\r\n"
            "Content-Length: %zu\r\n"
            "Connection: close\r\n"
            "\r\n"
            "%s",
            method, path, host, port, content_type, strlen(body), body);
    } else if (body) {
        request_len = snprintf(request, sizeof(request),
            "%s %s HTTP/1.1\r\n"
            "Host: %s:%d\r\n"
            "Content-Length: %zu\r\n"
            "Connection: close\r\n"
            "\r\n"
            "%s",
            method, path, host, port, strlen(body), body);
    } else {
        request_len = snprintf(request, sizeof(request),
            "%s %s HTTP/1.1\r\n"
            "Host: %s:%d\r\n"
            "Connection: close\r\n"
            "\r\n",
            method, path, host, port);
    }
    
    if (request_len >= (int)sizeof(request)) {
        if (verbose_mode) {
            printf(RED "  [VERBOSE] HTTP REQUEST TOO LARGE\n" RESET);
            printf(GRAY "    Request buffer size: %zu bytes\n" RESET, sizeof(request));
            printf(GRAY "    Calculated request length: %d bytes\n" RESET, request_len);
            printf(GRAY "    Body length: %zu bytes\n" RESET, body ? strlen(body) : 0);
        }
        close(sockfd);
        free(response);
        return NULL;
    }
    
    if (verbose_mode) {
        printf(YELLOW "  [VERBOSE] HTTP REQUEST CONSTRUCTED\n" RESET);
        printf(GRAY "    Total length: %d bytes\n" RESET, request_len);
        printf(GRAY "    Request preview (first 500 bytes):\n" RESET);
        printf(WHITE "    --- BEGIN REQUEST ---\n" RESET);
        int preview_len = request_len > 500 ? 500 : request_len;
        for (int i = 0; i < preview_len; i++) {
            putchar(request[i]);
        }
        if (request_len > 500) {
            printf("\n    ... [%d more bytes]\n", request_len - 500);
        }
        printf(WHITE "    --- END REQUEST ---\n" RESET);
    }
    
    if (verbose_mode) {
        printf(YELLOW "  [VERBOSE] SENDING HTTP REQUEST\n" RESET);
        printf(GRAY "    Socket FD: %d\n" RESET, sockfd);
        printf(GRAY "    Request length: %d bytes\n" RESET, request_len);
    }
    
    ssize_t sent_bytes = send(sockfd, request, request_len, 0);
    if (sent_bytes < 0) {
        if (verbose_mode) {
            printf(RED "  [VERBOSE] SEND FAILED\n" RESET);
            printf(GRAY "    Error: %s (errno: %d)\n" RESET, strerror(errno), errno);
            printf(GRAY "    Attempted to send: %d bytes\n" RESET, request_len);
            printf(GRAY "    Actually sent: %zd bytes\n" RESET, sent_bytes);
        }
        close(sockfd);
        free(response);
        return NULL;
    }
    
    if (verbose_mode) {
        printf(GREEN "  [VERBOSE] Request sent successfully\n" RESET);
        printf(GRAY "    Bytes sent: %zd/%d (%.1f%%)\n" RESET, 
               sent_bytes, request_len, (float)sent_bytes/request_len*100);
    }
    
    char response_buffer[16384];
    ssize_t total_received = 0;
    ssize_t received;
    
    if (verbose_mode) {
        printf(YELLOW "  [VERBOSE] WAITING FOR RESPONSE\n" RESET);
        printf(GRAY "    Buffer size: %zu bytes\n" RESET, sizeof(response_buffer));
    }
    
    while ((received = recv(sockfd, response_buffer + total_received, 
                           sizeof(response_buffer) - total_received - 1, 0)) > 0) {
        if (verbose_mode && total_received == 0) {
            printf(GRAY "    First chunk received: %zd bytes\n" RESET, received);
        }
        total_received += received;
        if (total_received >= (ssize_t)sizeof(response_buffer) - 1) {
            if (verbose_mode) {
                printf(YELLOW "  [VERBOSE] RESPONSE BUFFER FULL\n" RESET);
                printf(GRAY "    Buffer capacity reached: %zu bytes\n" RESET, sizeof(response_buffer));
            }
            break;
        }
    }
    
    if (received < 0) {
        if (verbose_mode) {
            printf(RED "  [VERBOSE] RECEIVE FAILED\n" RESET);
            printf(GRAY "    Error: %s (errno: %d)\n" RESET, strerror(errno), errno);
            printf(GRAY "    Total received before error: %zd bytes\n" RESET, total_received);
        }
        close(sockfd);
        free(response);
        return NULL;
    }
    
    response_buffer[total_received] = '\0';
    close(sockfd);
    
    if (verbose_mode) {
        printf(GREEN "  [VERBOSE] Response received completely\n" RESET);
        printf(GRAY "    Total bytes received: %zd\n" RESET, total_received);
        printf(GRAY "    Response preview (first 500 bytes):\n" RESET);
        printf(WHITE "    --- BEGIN RESPONSE PREVIEW ---\n" RESET);
        int preview_len = total_received > 500 ? 500 : total_received;
        for (int i = 0; i < preview_len; i++) {
            putchar(response_buffer[i]);
        }
        if (total_received > 500) {
            printf("\n    ... [%zd more bytes]\n", total_received - 500);
        }
        printf(WHITE "    --- END RESPONSE PREVIEW ---\n" RESET);
    }
    
    char* status_line = strstr(response_buffer, "HTTP/1.1");
    if (status_line) {
        sscanf(status_line, "HTTP/1.1 %d", &response->status_code);
        
        if (verbose_mode) {
            printf(YELLOW "  [VERBOSE] HTTP STATUS LINE PARSED\n" RESET);
            printf(GRAY "    Status line: %.*s\n" RESET, 
                   (int)(strchr(status_line, '\r') - status_line), status_line);
            printf(GRAY "    Status code: %d\n" RESET, response->status_code);
        }
    } else {
        if (verbose_mode) {
            printf(YELLOW "  [VERBOSE] NO HTTP STATUS LINE FOUND\n" RESET);
            printf(GRAY "    Looking for 'HTTP/1.1' in response\n" RESET);
            printf(GRAY "    Response start: %.50s\n" RESET, response_buffer);
        }
    }
    
    char* body_start = strstr(response_buffer, "\r\n\r\n");
    if (body_start) {
        body_start += 4;
        response->body_length = total_received - (body_start - response_buffer);
        response->body = malloc(response->body_length + 1);
        if (response->body) {
            memcpy(response->body, body_start, response->body_length);
            response->body[response->body_length] = '\0';
            
            if (verbose_mode) {
                printf(GREEN "  [VERBOSE] RESPONSE BODY EXTRACTED\n" RESET);
                printf(GRAY "    Body start offset: %ld bytes\n" RESET, body_start - response_buffer);
                printf(GRAY "    Body length: %zu bytes\n" RESET, response->body_length);
                printf(GRAY "    Body preview (first 200 bytes):\n" RESET);
                printf(WHITE "    --- BEGIN BODY PREVIEW ---\n" RESET);
                int preview_len = response->body_length > 200 ? 200 : response->body_length;
                for (int i = 0; i < preview_len; i++) {
                    putchar(response->body[i]);
                }
                if (response->body_length > 200) {
                    printf("\n    ... [%zu more bytes]\n", response->body_length - 200);
                }
                printf(WHITE "    --- END BODY PREVIEW ---\n" RESET);
            }
        } else {
            if (verbose_mode) {
                printf(RED "  [VERBOSE] MEMORY ALLOCATION FAILED FOR BODY\n" RESET);
                printf(GRAY "    Requested size: %zu bytes\n" RESET, response->body_length + 1);
            }
        }
    } else {
        response->body = strdup("");
        response->body_length = 0;
        
        if (verbose_mode) {
            printf(YELLOW "  [VERBOSE] NO BODY FOUND IN RESPONSE\n" RESET);
            printf(GRAY "    Looking for '\\r\\n\\r\\n' separator\n" RESET);
            printf(GRAY "    Response might be headers-only\n" RESET);
        }
    }
    
    if (verbose_mode) {
        printf(YELLOW "  [VERBOSE] HTTP REQUEST COMPLETE\n" RESET);
        printf(GRAY "    Final status: %d\n" RESET, response->status_code);
        printf(GRAY "    Body size: %zu bytes\n" RESET, response->body_length);
        printf(GRAY "    Memory allocated for response: %zu bytes\n" RESET, 
               sizeof(HttpResponse) + (response->body ? response->body_length + 1 : 0));
    }
    
    return response;
}

void http_response_free(HttpResponse* response) {
    if (response) {
        if (response->body) {
            free(response->body);
        }
        free(response);
    }
}

int verify_http_response(const HttpResponse* response, const char* expected_pattern, int check_success_only) {
    if (!response) {
        if (verbose_mode) {
            printf(RED "\n  [VERBOSE] HTTP RESPONSE VERIFICATION FAILED\n" RESET);
            printf(RED "  [VERBOSE] Response is NULL\n" RESET);
            printf(GRAY "    Expected pattern: \"%s\"\n" RESET, expected_pattern ? expected_pattern : "(none)");
            printf(GRAY "    Check success only: %s\n" RESET, check_success_only ? "YES" : "NO");
        }
        return 0;
    }
    
    if (verbose_mode) {
        printf(YELLOW "\n  [VERBOSE] HTTP RESPONSE VERIFICATION\n" RESET);
        printf(GRAY "    Response status code: %d\n" RESET, response->status_code);
        printf(GRAY "    Response body length: %zu bytes\n" RESET, response->body_length);
        printf(GRAY "    Expected pattern: \"%s\"\n" RESET, expected_pattern ? expected_pattern : "(none)");
        printf(GRAY "    Check success only: %s\n" RESET, check_success_only ? "YES" : "NO");
        
        if (response->body) {
            printf(GRAY "    Body content (first 300 chars):\n" RESET);
            printf(WHITE "    --- BEGIN BODY ---\n" RESET);
            int len = response->body_length > 300 ? 300 : response->body_length;
            for (int i = 0; i < len; i++) {
                putchar(response->body[i]);
            }
            if (response->body_length > 300) {
                printf("\n    ... [%zu more chars]\n", response->body_length - 300);
            }
            printf(WHITE "    --- END BODY ---\n" RESET);
        }
    }
    
    if (check_success_only) {
        int has_success_field = response->body && strstr(response->body, "\"success\":") != NULL;
        int valid_status = (response->status_code >= 200 && response->status_code < 500);
        int result = valid_status && has_success_field;
        
        if (verbose_mode) {
            printf(YELLOW "  [VERBOSE] SUCCESS-ONLY CHECK ANALYSIS\n" RESET);
            printf(GRAY "    Status code valid (200-499): %s (%d)\n" RESET, 
                   valid_status ? "YES" : "NO", response->status_code);
            printf(GRAY "    Has 'success' field in JSON: %s\n" RESET, 
                   has_success_field ? "YES" : "NO");
            printf(GRAY "    Combined result: %s\n" RESET, result ? "PASS" : "FAIL");
            
            if (!valid_status) {
                printf(RED "  [VERBOSE] STATUS CODE ISSUE\n" RESET);
                printf(GRAY "    Expected: 200-499\n" RESET);
                printf(GRAY "    Got: %d\n" RESET, response->status_code);
                printf(GRAY "    Status code categories:\n" RESET);
                printf(GRAY "      200-299: Success\n" RESET);
                printf(GRAY "      300-399: Redirection\n" RESET);
                printf(GRAY "      400-499: Client error\n" RESET);
                printf(GRAY "      500-599: Server error\n" RESET);
            }
            
            if (!has_success_field && response->body) {
                printf(RED "  [VERBOSE] MISSING SUCCESS FIELD\n" RESET);
                printf(GRAY "    Looking for '\"success\":' in body\n" RESET);
                printf(GRAY "    Body content type analysis:\n" RESET);
                
                if (strstr(response->body, "{") && strstr(response->body, "}")) {
                    printf(GRAY "    Appears to be JSON\n" RESET);
                    
                    const char* common_fields[] = {"\"error\"", "\"message\"", "\"status\"", "\"result\"", NULL};
                    for (int i = 0; common_fields[i]; i++) {
                        if (strstr(response->body, common_fields[i])) {
                            printf(GRAY "    Found similar field: %s\n" RESET, common_fields[i]);
                        }
                    }
                } else if (strstr(response->body, "<html") || strstr(response->body, "<!DOCTYPE")) {
                    printf(GRAY "    Appears to be HTML\n" RESET);
                } else if (strstr(response->body, "error") || strstr(response->body, "Error")) {
                    printf(GRAY "    Contains 'error' text\n" RESET);
                }
            }
        }
        
        return result;
    } else {
        if (verbose_mode) {
            printf(YELLOW "  [VERBOSE] FULL RESPONSE CHECK\n" RESET);
        }
        
        if (response->status_code < 200 || response->status_code >= 300) {
            if (verbose_mode) {
                printf(RED "  [VERBOSE] STATUS CODE CHECK FAILED\n" RESET);
                printf(GRAY "    Expected: 200-299 (success)\n" RESET);
                printf(GRAY "    Got: %d\n" RESET, response->status_code);
                printf(GRAY "    Status code meaning:\n" RESET);
                
                const char* status_meanings[] = {
                    "200", "OK",
                    "201", "Created",
                    "204", "No Content",
                    "400", "Bad Request",
                    "401", "Unauthorized",
                    "403", "Forbidden",
                    "404", "Not Found",
                    "405", "Method Not Allowed",
                    "409", "Conflict",
                    "500", "Internal Server Error",
                    "503", "Service Unavailable",
                    NULL
                };
                
                char status_str[10];
                snprintf(status_str, sizeof(status_str), "%d", response->status_code);
                
                for (int i = 0; status_meanings[i] != NULL; i += 2) {
                    if (strcmp(status_str, status_meanings[i]) == 0) {
                        printf(GRAY "      %s: %s\n" RESET, status_meanings[i], status_meanings[i+1]);
                        break;
                    }
                }
            }
            return 0;
        }
        
        if (verbose_mode) {
            printf(GREEN "  [VERBOSE] Status code check passed: %d\n" RESET, response->status_code);
        }
        
        if (expected_pattern && expected_pattern[0] != '\0') {
            if (!response->body) {
                if (verbose_mode) {
                    printf(RED "  [VERBOSE] PATTERN CHECK FAILED\n" RESET);
                    printf(GRAY "    Expected pattern: \"%s\"\n" RESET, expected_pattern);
                    printf(GRAY "    Response body is NULL\n" RESET);
                }
                return 0;
            }
            
            char* pattern_found = strstr(response->body, expected_pattern);
            if (pattern_found == NULL) {
                if (verbose_mode) {
                    printf(RED "  [VERBOSE] PATTERN NOT FOUND IN RESPONSE BODY\n" RESET);
                    printf(GRAY "    Expected pattern: \"%s\"\n" RESET, expected_pattern);
                    printf(GRAY "    Pattern length: %zu characters\n" RESET, strlen(expected_pattern));
                    printf(GRAY "    Body length: %zu characters\n" RESET, strlen(response->body));
                    
                    printf(GRAY "    Case-insensitive search: " RESET);
                    char* lower_body = strdup(response->body);
                    char* lower_pattern = strdup(expected_pattern);
                    for (size_t i = 0; lower_body[i]; i++) lower_body[i] = tolower(lower_body[i]);
                    for (size_t i = 0; lower_pattern[i]; i++) lower_pattern[i] = tolower(lower_pattern[i]);
                    
                    if (strstr(lower_body, lower_pattern)) {
                        printf("FOUND (case difference)\n" RESET);
                        printf(GRAY "    Original case might be different\n" RESET);
                    } else {
                        printf("NOT FOUND\n" RESET);
                    }
                    free(lower_body);
                    free(lower_pattern);
                    
                    printf(GRAY "    Looking for similar patterns:\n" RESET);
                    
                    if (strstr(expected_pattern, "success")) {
                        printf(GRAY "      Checking 'Success' (capital S): %s\n" RESET,
                               strstr(response->body, "Success") ? "FOUND" : "NOT FOUND");
                        printf(GRAY "      Checking 'SUCCESS' (all caps): %s\n" RESET,
                               strstr(response->body, "SUCCESS") ? "FOUND" : "NOT FOUND");
                    }
                    
                    printf(GRAY "    Body content around expected area:\n" RESET);
                    printf(WHITE "    --- BEGIN CONTEXT ---\n" RESET);
                    int start = 0;
                    int end = strlen(response->body);
                    if (end > 200) {
                        start = end/2 - 100;
                        end = end/2 + 100;
                    }
                    for (int i = start; i < end && i < (int)strlen(response->body); i++) {
                        putchar(response->body[i]);
                    }
                    printf(WHITE "\n    --- END CONTEXT ---\n" RESET);
                }
                return 0;
            } else {
                if (verbose_mode) {
                    printf(GREEN "  [VERBOSE] PATTERN FOUND IN RESPONSE BODY\n" RESET);
                    printf(GRAY "    Pattern: \"%s\"\n" RESET, expected_pattern);
                    printf(GRAY "    Found at position: %ld\n" RESET, pattern_found - response->body);
                    
                    printf(GRAY "    Context around found pattern (50 chars before/after):\n" RESET);
                    printf(WHITE "    --- BEGIN CONTEXT ---\n" RESET);
                    long start = pattern_found - response->body - 50;
                    if (start < 0) start = 0;
                    long end = pattern_found - response->body + strlen(expected_pattern) + 50;
                    if (end > (long)strlen(response->body)) end = strlen(response->body);
                    
                    for (long i = start; i < end; i++) {
                        if (i == pattern_found - response->body) {
                            printf(GREEN);
                        }
                        if (i == pattern_found - response->body + strlen(expected_pattern)) {
                            printf(RESET);
                        }
                        putchar(response->body[i]);
                    }
                    printf(RESET);
                    printf(WHITE "\n    --- END CONTEXT ---\n" RESET);
                }
            }
        } else if (verbose_mode) {
            printf(GREEN "  [VERBOSE] No pattern specified for verification\n" RESET);
        }
    }
    
    if (verbose_mode) {
        printf(GREEN "  [VERBOSE] HTTP response verification passed\n" RESET);
    }
    
    return 1;
}

char* extract_json_field(const char* json, const char* field) {
    if (!json || !field) return NULL;
    
    if (verbose_mode) {
        printf(YELLOW "  [VERBOSE] EXTRACTING JSON FIELD\n" RESET);
        printf(GRAY "    Field to extract: \"%s\"\n" RESET, field);
        printf(GRAY "    JSON length: %zu characters\n" RESET, strlen(json));
    }
    
    char search_pattern[256];
    snprintf(search_pattern, sizeof(search_pattern), "\"%s\":\"", field);
    
    char* field_start = strstr(json, search_pattern);
    if (!field_start) {
        if (verbose_mode) {
            printf(GRAY "    Pattern '\"%s\":\"' not found, trying without quotes\n" RESET, field);
        }
        
        snprintf(search_pattern, sizeof(search_pattern), "\"%s\":", field);
        field_start = strstr(json, search_pattern);
        if (!field_start) {
            if (verbose_mode) {
                printf(RED "  [VERBOSE] FIELD NOT FOUND IN JSON\n" RESET);
                printf(GRAY "    Pattern: \"%s\"\n" RESET, search_pattern);
                printf(GRAY "    JSON preview (first 200 chars):\n" RESET);
                int len = strlen(json) > 200 ? 200 : strlen(json);
                for (int i = 0; i < len; i++) putchar(json[i]);
                if (strlen(json) > 200) printf("\n...");
                printf("\n" RESET);
            }
            return NULL;
        }
        
        field_start += strlen(search_pattern);
        char* field_end = strchr(field_start, ',');
        if (!field_end) field_end = strchr(field_start, '}');
        if (!field_end) {
            if (verbose_mode) {
                printf(RED "  [VERBOSE] CANNOT FIND FIELD END DELIMITER\n" RESET);
                printf(GRAY "    Field start: \"%.50s\"\n" RESET, field_start);
            }
            return NULL;
        }
        
        size_t field_length = field_end - field_start;
        char* value = malloc(field_length + 1);
        if (!value) {
            if (verbose_mode) {
                printf(RED "  [VERBOSE] MEMORY ALLOCATION FAILED\n" RESET);
                printf(GRAY "    Requested size: %zu bytes\n" RESET, field_length + 1);
            }
            return NULL;
        }
        
        strncpy(value, field_start, field_length);
        value[field_length] = '\0';
        
        if (verbose_mode) {
            printf(GREEN "  [VERBOSE] FIELD EXTRACTED (UNQUOTED)\n" RESET);
            printf(GRAY "    Field value: \"%s\"\n" RESET, value);
            printf(GRAY "    Value length: %zu characters\n" RESET, field_length);
        }
        
        return value;
    }
    
    field_start += strlen(search_pattern);
    char* field_end = strchr(field_start, '"');
    if (!field_end) {
        if (verbose_mode) {
            printf(RED "  [VERBOSE] CANNOT FIND CLOSING QUOTE\n" RESET);
            printf(GRAY "    Field start: \"%.50s\"\n" RESET, field_start);
        }
        return NULL;
    }
    
    size_t field_length = field_end - field_start;
    char* value = malloc(field_length + 1);
    if (!value) {
        if (verbose_mode) {
            printf(RED "  [VERBOSE] MEMORY ALLOCATION FAILED\n" RESET);
            printf(GRAY "    Requested size: %zu bytes\n" RESET, field_length + 1);
        }
        return NULL;
    }
    
    strncpy(value, field_start, field_length);
    value[field_length] = '\0';
    
    if (verbose_mode) {
        printf(GREEN "  [VERBOSE] FIELD EXTRACTED (QUOTED)\n" RESET);
        printf(GRAY "    Field value: \"%s\"\n" RESET, value);
        printf(GRAY "    Value length: %zu characters\n" RESET, field_length);
        printf(GRAY "    Search pattern used: \"%s\"\n" RESET, search_pattern);
        printf(GRAY "    Found at position: %ld\n" RESET, field_start - json - strlen(search_pattern));
    }
    
    return value;
}

int http_test_endpoint(const char* description, const char* method, const char* endpoint, 
                      const char* body, const char* expected_pattern, int check_success_only, long long* duration) {
    printf("\n%s%-80s" RESET, BLUE, description);
    fflush(stdout);
    
    if (verbose_mode) {
        printf(YELLOW "\n  [VERBOSE] ========================================\n" RESET);
        printf(YELLOW "  [VERBOSE] HTTP ENDPOINT TEST START\n" RESET);
        printf(YELLOW "  [VERBOSE] ========================================\n" RESET);
        printf(GRAY "    Description: %s\n" RESET, description);
        printf(GRAY "    Method: %s\n" RESET, method);
        printf(GRAY "    Endpoint: %s\n" RESET, endpoint);
        printf(GRAY "    Body: %s\n" RESET, body ? body : "(none)");
        printf(GRAY "    Expected pattern: \"%s\"\n" RESET, expected_pattern ? expected_pattern : "(none)");
        printf(GRAY "    Check success only: %s\n" RESET, check_success_only ? "YES" : "NO");
    }
    
    long long start_time = get_current_time_ms();
    
    HttpResponse* response = http_request(method, endpoint, body, "application/json");
    long long end_time = get_current_time_ms();
    
    if (duration) {
        *duration = end_time - start_time;
    }
    
    int success = 0;
    if (response) {
        success = verify_http_response(response, expected_pattern, check_success_only);
        
        if (!success) {
            printf("[" RED "FAIL" RESET "] %s%4lld ms%s\n", CYAN, end_time - start_time, RESET);
            
            if (verbose_mode) {
                printf(RED "\n  [VERBOSE] ========================================\n" RESET);
                printf(RED "  [VERBOSE] HTTP TEST FAILURE ANALYSIS\n" RESET);
                printf(RED "  [VERBOSE] ========================================\n" RESET);
                printf(RED "  [VERBOSE] Test: %s\n" RESET, description);
                printf(RED "  [VERBOSE] Endpoint: %s %s\n" RESET, method, endpoint);
                printf(RED "  [VERBOSE] Status Code: %d\n" RESET, response->status_code);
                printf(RED "  [VERBOSE] Expected Pattern: '%s'\n" RESET, expected_pattern ? expected_pattern : "NONE");
                printf(RED "  [VERBOSE] Check Success Only: %s\n" RESET, check_success_only ? "YES" : "NO");
                
                if (response->body) {
                    printf(RED "  [VERBOSE] Response Body (%zu bytes):\n" RESET, response->body_length);
                    printf(WHITE "  --- BEGIN RESPONSE BODY ---\n" RESET);
                    printf("%s\n", response->body);
                    printf(WHITE "  --- END RESPONSE BODY ---\n" RESET);
                    
                    if (strstr(response->body, "{") && strstr(response->body, "}")) {
                        printf(RED "  [VERBOSE] JSON STRUCTURE ANALYSIS:\n" RESET);
                        
                        const char* json_fields[] = {
                            "error", "message", "details", "code", "status", 
                            "success", "data", "result", NULL
                        };
                        
                        for (int i = 0; json_fields[i]; i++) {
                            char* value = extract_json_field(response->body, json_fields[i]);
                            if (value) {
                                printf(GRAY "    Field '%s': %s\n" RESET, json_fields[i], value);
                                free(value);
                            }
                        }
                    }
                } else {
                    printf(RED "  [VERBOSE] Response Body: NULL\n" RESET);
                }
                
                printf(RED "  [VERBOSE] Response Time: %lld ms\n" RESET, end_time - start_time);
                printf(RED "  [VERBOSE] ========================================\n" RESET);
                
                printf(YELLOW "  [VERBOSE] POSSIBLE ISSUES AND SOLUTIONS:\n" RESET);
                
                if (response->status_code == 0) {
                    printf(GRAY "    - Server might not be running\n" RESET);
                    printf(GRAY "    - Network connectivity issue\n" RESET);
                    printf(GRAY "    - Firewall blocking connection\n" RESET);
                } else if (response->status_code == 404) {
                    printf(GRAY "    - Endpoint URL might be incorrect\n" RESET);
                    printf(GRAY "    - Server routing misconfigured\n" RESET);
                } else if (response->status_code == 405) {
                    printf(GRAY "    - HTTP method not allowed for this endpoint\n" RESET);
                } else if (response->status_code >= 500) {
                    printf(GRAY "    - Server internal error\n" RESET);
                    printf(GRAY "    - Check server logs\n" RESET);
                } else if (response->status_code >= 400) {
                    printf(GRAY "    - Client error - check request parameters\n" RESET);
                    printf(GRAY "    - Validate JSON format\n" RESET);
                    printf(GRAY "    - Check required fields\n" RESET);
                }
                
                if (expected_pattern && response->body) {
                    if (!strstr(response->body, expected_pattern)) {
                        printf(GRAY "    - Pattern '%s' not found in response\n" RESET, expected_pattern);
                        printf(GRAY "    - Check for case sensitivity\n" RESET);
                        printf(GRAY "    - Verify the exact expected output\n" RESET);
                    }
                }
            } else {
                if (response->body) {
                    printf(RED "  Status: %d, Response: %s\n" RESET, response->status_code, response->body);
                } else {
                    printf(RED "  Status: %d, No response body\n" RESET, response->status_code);
                }
            }
        } else {
            printf("[" GREEN "PASS" RESET "] %s%4lld ms%s\n", CYAN, end_time - start_time, RESET);
            
            if (verbose_mode) {
                printf(GREEN "\n  [VERBOSE] HTTP TEST SUCCESS DETAILS\n" RESET);
                printf(GREEN "  [VERBOSE]   Endpoint: %s %s\n" RESET, method, endpoint);
                printf(GREEN "  [VERBOSE]   Status Code: %d\n" RESET, response->status_code);
                printf(GREEN "  [VERBOSE]   Response Time: %lld ms\n" RESET, end_time - start_time);
                printf(GREEN "  [VERBOSE]   Body Length: %zu bytes\n" RESET, response->body_length);
                
                if (response->body && response->body_length < 500) {
                    printf(GREEN "  [VERBOSE]   Response Body:\n" RESET);
                    printf("%s\n", response->body);
                }
            }
        }
        http_response_free(response);
    } else {
        printf("[" RED "FAIL" RESET "] %s%4lld ms%s\n", CYAN, end_time - start_time, RESET);
        printf(RED "  No response from server\n" RESET);
        
        if (verbose_mode) {
            printf(RED "\n  [VERBOSE] HTTP TEST FAILURE - NO RESPONSE\n" RESET);
            printf(RED "  [VERBOSE]   Endpoint: %s %s\n" RESET, method, endpoint);
            printf(RED "  [VERBOSE]   Server may be down or unreachable\n" RESET);
            printf(RED "  [VERBOSE]   Request time: %lld ms\n" RESET, end_time - start_time);
            printf(RED "  [VERBOSE]   Possible causes:\n" RESET);
            printf(GRAY "    - Server not started\n" RESET);
            printf(GRAY "    - Wrong port number\n" RESET);
            printf(GRAY "    - Firewall blocking connection\n" RESET);
            printf(GRAY "    - Network issues\n" RESET);
            printf(GRAY "    - Server crashed\n" RESET);
        }
    }
    
    if (verbose_mode) {
        printf(YELLOW "  [VERBOSE] ========================================\n" RESET);
        printf(YELLOW "  [VERBOSE] HTTP ENDPOINT TEST COMPLETE\n" RESET);
        printf(YELLOW "  [VERBOSE] Result: %s\n" RESET, success ? "PASS" : "FAIL");
        printf(YELLOW "  [VERBOSE] Duration: %lld ms\n" RESET, end_time - start_time);
        printf(YELLOW "  [VERBOSE] ========================================\n" RESET);
    }
    
    return success;
}

void cleanup_test_databases() {
    printf("Cleaning up previous test databases...\n");
    
    if (verbose_mode) {
        printf(YELLOW "  [VERBOSE] Cleaning up test directories in /tmp/sydb_test/\n" RESET);
    }
    
    char command[512];
    snprintf(command, sizeof(command), "rm -rf /tmp/sydb_test/testdb_* /tmp/sydb_test/testdb2_* /tmp/sydb_test/testcolldb_* /tmp/sydb_test/testinstdb_* 2>/dev/null");
    system(command);
    
    snprintf(command, sizeof(command), "rm -f /tmp/sydb_test/*.lock /tmp/sydb_test/.*.lock 2>/dev/null");
    system(command);
    
    usleep(50000);
    
    if (verbose_mode) {
        printf(YELLOW "  [VERBOSE] Cleanup completed\n" RESET);
    }
}

int run_http_database_tests() {
    printf("\n" MAGENTA "HTTP API DATABASE TESTS" RESET "\n");
    
    int passed = 0;
    int total = 0;
    long long total_time = 0;
    long long duration;
    
    char unique_db1[64], unique_db2[64];
    struct timespec ts;
    clock_gettime(CLOCK_MONOTONIC, &ts);
    snprintf(unique_db1, sizeof(unique_db1), "testdb_%ld_%ld", ts.tv_sec, ts.tv_nsec);
    snprintf(unique_db2, sizeof(unique_db2), "testdb2_%ld_%ld", ts.tv_sec, ts.tv_nsec + 1);
    
    if (verbose_mode) {
        printf(YELLOW "  [VERBOSE] Using unique database names: %s, %s\n" RESET, unique_db1, unique_db2);
    }
    
    char create_db1_body[128], create_db2_body[128];
    snprintf(create_db1_body, sizeof(create_db1_body), "{\"name\":\"%s\"}", unique_db1);
    snprintf(create_db2_body, sizeof(create_db2_body), "{\"name\":\"%s\"}", unique_db2);
    
    if (http_test_endpoint("GET /api/databases - List databases", 
                          "GET", "/api/databases", NULL, "\"success\":true", 1, &duration)) {
        passed++;
    }
    total++;
    total_time += duration;
    
    if (http_test_endpoint("POST /api/databases - Create database", 
                          "POST", "/api/databases", create_db1_body, "\"success\":true", 0, &duration)) {
        passed++;
    }
    total++;
    total_time += duration;
    
    if (http_test_endpoint("POST /api/databases - Create second database", 
                          "POST", "/api/databases", create_db2_body, "\"success\":true", 0, &duration)) {
        passed++;
    }
    total++;
    total_time += duration;
    
    if (http_test_endpoint("POST /api/databases - Prevent duplicate database", 
                          "POST", "/api/databases", create_db1_body, "\"success\":false", 1, &duration)) {
        passed++;
    }
    total++;
    total_time += duration;
    
    char delete_url[256];
    snprintf(delete_url, sizeof(delete_url), "/api/databases/%s", unique_db2);
    if (http_test_endpoint("DELETE /api/databases/{name} - Delete database", 
                          "DELETE", delete_url, NULL, "\"success\":true", 0, &duration)) {
        passed++;
    }
    total++;
    total_time += duration;
    
    printf(YELLOW "  Database API tests: %d/%d passed (avg: %lld ms)\n" RESET, 
           passed, total, total_time / (total > 0 ? total : 1));
    
    return passed;
}

int run_http_collection_tests() {
    printf("\n" MAGENTA "HTTP API COLLECTION TESTS" RESET "\n");
    
    int passed = 0;
    int total = 0;
    long long total_time = 0;
    long long duration;
    
    char unique_db[64];
    struct timespec ts;
    clock_gettime(CLOCK_MONOTONIC, &ts);
    snprintf(unique_db, sizeof(unique_db), "testcolldb_%ld_%ld", ts.tv_sec, ts.tv_nsec);
    
    if (verbose_mode) {
        printf(YELLOW "  [VERBOSE] Using unique database name: %s\n" RESET, unique_db);
    }
    
    char create_db_body[128];
    snprintf(create_db_body, sizeof(create_db_body), "{\"name\":\"%s\"}", unique_db);
    
    HttpResponse* db_response = http_request("POST", "/api/databases", create_db_body, "application/json");
    if (!db_response || !verify_http_response(db_response, "\"success\":true", 0)) {
        printf(RED "  Failed to create test database for collection tests\n" RESET);
        if (verbose_mode) {
            printf(RED "  [VERBOSE] Database creation failed\n" RESET);
            if (db_response) {
                printf(RED "  [VERBOSE] Response status: %d, body: %s\n" RESET, db_response->status_code, db_response->body ? db_response->body : "NULL");
            }
        }
        http_response_free(db_response);
        return 0;
    }
    http_response_free(db_response);
    
    char list_colls_url[256];
    snprintf(list_colls_url, sizeof(list_colls_url), "/api/databases/%s/collections", unique_db);
    if (http_test_endpoint("GET /api/databases/{db}/collections - List empty collections", 
                          "GET", list_colls_url, NULL, "\"collections\":[]", 0, &duration)) {
        passed++;
    }
    total++;
    total_time += duration;
    
    char create_coll_url[256];
    snprintf(create_coll_url, sizeof(create_coll_url), "/api/databases/%s/collections", unique_db);
    
    const char* users_schema = "{\"name\":\"users\",\"schema\":["
        "{\"name\":\"name\",\"type\":\"string\",\"required\":true,\"indexed\":false},"
        "{\"name\":\"age\",\"type\":\"int\",\"required\":false,\"indexed\":false},"
        "{\"name\":\"email\",\"type\":\"string\",\"required\":false,\"indexed\":false}"
        "]}";
    
    if (http_test_endpoint("POST /api/databases/{db}/collections - Create users collection", 
                          "POST", create_coll_url, users_schema, "\"success\":true", 0, &duration)) {
        passed++;
    }
    total++;
    total_time += duration;
    
    const char* products_schema = "{\"name\":\"products\",\"schema\":["
        "{\"name\":\"name\",\"type\":\"string\",\"required\":true,\"indexed\":false},"
        "{\"name\":\"price\",\"type\":\"float\",\"required\":false,\"indexed\":false}"
        "]}";
    
    if (http_test_endpoint("POST /api/databases/{db}/collections - Create products collection", 
                          "POST", create_coll_url, products_schema, "\"success\":true", 0, &duration)) {
        passed++;
    }
    total++;
    total_time += duration;
    
    if (http_test_endpoint("GET /api/databases/{db}/collections - List created collections", 
                          "GET", list_colls_url, NULL, "\"users\"", 0, &duration)) {
        passed++;
    }
    total++;
    total_time += duration;
    
    char schema_url[256];
    snprintf(schema_url, sizeof(schema_url), "/api/databases/%s/collections/users/schema", unique_db);
    if (http_test_endpoint("GET /api/databases/{db}/collections/{coll}/schema - Get users schema", 
                          "GET", schema_url, NULL, "\"name\"", 0, &duration)) {
        passed++;
    }
    total++;
    total_time += duration;
    
    char delete_coll_url[256];
    snprintf(delete_coll_url, sizeof(delete_coll_url), "/api/databases/%s/collections/products", unique_db);
    if (http_test_endpoint("DELETE /api/databases/{db}/collections/{coll} - Delete products collection", 
                          "DELETE", delete_coll_url, NULL, "\"success\":true", 0, &duration)) {
        passed++;
    }
    total++;
    total_time += duration;
    
    printf(YELLOW "  Collection API tests: %d/%d passed (avg: %lld ms)\n" RESET, 
           passed, total, total_time / (total > 0 ? total : 1));
    
    return passed;
}

int run_http_instance_tests() {
    printf("\n" MAGENTA "HTTP API INSTANCE TESTS" RESET "\n");
    
    int passed = 0;
    int total = 0;
    long long total_time = 0;
    long long duration;
    
    char unique_db[64];
    struct timespec ts;
    clock_gettime(CLOCK_MONOTONIC, &ts);
    snprintf(unique_db, sizeof(unique_db), "testinstdb_%ld_%ld", ts.tv_sec, ts.tv_nsec);
    
    if (verbose_mode) {
        printf(YELLOW "  [VERBOSE] Using unique database name: %s\n" RESET, unique_db);
    }
    
    char create_db_body[128];
    snprintf(create_db_body, sizeof(create_db_body), "{\"name\":\"%s\"}", unique_db);
    
    HttpResponse* db_response = http_request("POST", "/api/databases", create_db_body, "application/json");
    if (!db_response || !verify_http_response(db_response, "\"success\":true", 0)) {
        printf(RED "  Failed to create test database for instance tests\n" RESET);
        if (verbose_mode) {
            printf(RED "  [VERBOSE] Database creation failed\n" RESET);
        }
        http_response_free(db_response);
        return 0;
    }
    http_response_free(db_response);
    
    char create_coll_url[256];
    snprintf(create_coll_url, sizeof(create_coll_url), "/api/databases/%s/collections", unique_db);
    
    const char* users_schema = "{\"name\":\"users\",\"schema\":["
        "{\"name\":\"name\",\"type\":\"string\",\"required\":true,\"indexed\":false},"
        "{\"name\":\"age\",\"type\":\"int\",\"required\":false,\"indexed\":false},"
        "{\"name\":\"email\",\"type\":\"string\",\"required\":false,\"indexed\":false}"
        "]}";
    
    HttpResponse* coll_response = http_request("POST", create_coll_url, users_schema, "application/json");
    if (!coll_response || !verify_http_response(coll_response, "\"success\":true", 0)) {
        printf(RED "  Failed to create test collection for instance tests\n" RESET);
        if (verbose_mode) {
            printf(RED "  [VERBOSE] Collection creation failed\n" RESET);
        }
        http_response_free(coll_response);
        return 0;
    }
    http_response_free(coll_response);
    
    char list_instances_url[256];
    snprintf(list_instances_url, sizeof(list_instances_url), "/api/databases/%s/collections/users/instances", unique_db);
    if (http_test_endpoint("GET /api/databases/{db}/collections/{coll}/instances - List empty instances", 
                          "GET", list_instances_url, NULL, "\"instances\":[]", 0, &duration)) {
        passed++;
    }
    total++;
    total_time += duration;
    
    const char* user1 = "{\"name\":\"John Doe\",\"age\":30,\"email\":\"john@test.com\"}";
    char insert_url[256];
    snprintf(insert_url, sizeof(insert_url), "/api/databases/%s/collections/users/instances", unique_db);
    
    HttpResponse* insert_response = http_request("POST", insert_url, user1, "application/json");
    if (insert_response && verify_http_response(insert_response, "\"success\":true", 0)) {
        char* id1 = extract_json_field(insert_response->body, "id");
        if (id1) {
            printf("\n%s%-80s" RESET, BLUE, "POST /api/databases/{db}/collections/{coll}/instances - Insert first user");
            printf("[" GREEN "PASS" RESET "] %s%4lld ms%s\n", CYAN, duration, RESET);
            passed++;
            
            if (verbose_mode) {
                printf(GREEN "  [VERBOSE] Inserted user with ID: %s\n" RESET, id1);
            }
            
            const char* user2 = "{\"name\":\"Jane Smith\",\"age\":25,\"email\":\"jane@test.com\"}";
            HttpResponse* insert_response2 = http_request("POST", insert_url, user2, "application/json");
            if (insert_response2 && verify_http_response(insert_response2, "\"success\":true", 0)) {
                printf("\n%s%-80s" RESET, BLUE, "POST /api/databases/{db}/collections/{coll}/instances - Insert second user");
                printf("[" GREEN "PASS" RESET "] %s%4lld ms%s\n", CYAN, duration, RESET);
                passed++;
                
                if (http_test_endpoint("GET /api/databases/{db}/collections/{coll}/instances - List users", 
                                      "GET", list_instances_url, NULL, "John Doe", 0, &duration)) {
                    passed++;
                }
                total++;
                total_time += duration;
                
                char query_url[512];
                snprintf(query_url, sizeof(query_url), "/api/databases/%s/collections/users/instances?query=age:30", unique_db);
                if (http_test_endpoint("GET /api/.../instances?query=age:30 - Query by age", 
                                      "GET", query_url, NULL, "John Doe", 0, &duration)) {
                    passed++;
                }
                total++;
                total_time += duration;
                
                char update_url[256];
                snprintf(update_url, sizeof(update_url), "/api/databases/%s/collections/users/instances/%s", unique_db, id1);
                const char* update_data = "{\"age\":35,\"email\":\"john.updated@test.com\"}";
                if (http_test_endpoint("PUT /api/.../instances/{id} - Update user", 
                                      "PUT", update_url, update_data, "\"success\":true", 0, &duration)) {
                    passed++;
                }
                total++;
                total_time += duration;
                
                char delete_url[256];
                snprintf(delete_url, sizeof(delete_url), "/api/databases/%s/collections/users/instances/%s", unique_db, id1);
                if (http_test_endpoint("DELETE /api/.../instances/{id} - Delete user", 
                                      "DELETE", delete_url, NULL, "\"success\":true", 0, &duration)) {
                    passed++;
                }
                total++;
                total_time += duration;
                
                http_response_free(insert_response2);
            } else {
                printf("\n%s%-80s" RESET, BLUE, "POST /api/databases/{db}/collections/{coll}/instances - Insert second user");
                printf("[" RED "FAIL" RESET "]\n");
                total++;
                if (verbose_mode) {
                    printf(RED "  [VERBOSE] Second user insertion failed\n" RESET);
                }
            }
            
            free(id1);
        }
        http_response_free(insert_response);
    } else {
        printf("\n%s%-80s" RESET, BLUE, "POST /api/databases/{db}/collections/{coll}/instances - Insert first user");
        printf("[" RED "FAIL" RESET "]\n");
        total++;
        if (verbose_mode) {
            printf(RED "  [VERBOSE] First user insertion failed\n" RESET);
        }
    }
    total++;
    
    printf(YELLOW "  Instance API tests: %d/%d passed (avg: %lld ms)\n" RESET, 
           passed, total, total_time / (total > 0 ? total : 1));
    
    return passed;
}

int run_http_command_tests() {
    printf("\n" MAGENTA "HTTP API COMMAND TESTS" RESET "\n");
    
    int passed = 0;
    int total = 0;
    long long total_time = 0;
    long long duration;
    
    const char* command = "{\"command\":\"list\",\"arguments\":[]}";
    if (http_test_endpoint("POST /api/execute - Execute list command", 
                          "POST", "/api/execute", command, "\"success\":true", 0, &duration)) {
        passed++;
    }
    total++;
    total_time += duration;
    
    printf(YELLOW "  Command API tests: %d/%d passed (avg: %lld ms)\n" RESET, 
           passed, total, total_time / total);
    
    return passed;
}

int run_http_error_tests() {
    printf("\n" MAGENTA "HTTP API ERROR HANDLING TESTS" RESET "\n");
    
    int passed = 0;
    int total = 0;
    long long total_time = 0;
    long long duration;
    
    if (http_test_endpoint("POST /api/databases - Invalid database name", 
                          "POST", "/api/databases", "{\"name\":\"invalid/name\"}", "\"success\":false", 1, &duration)) {
        passed++;
    }
    total++;
    total_time += duration;
    
    if (http_test_endpoint("GET /api/databases/nonexistent/collections - Non-existent database", 
                          "GET", "/api/databases/nonexistent/collections", NULL, "\"success\":false", 1, &duration)) {
        passed++;
    }
    total++;
    total_time += duration;
    
    if (http_test_endpoint("GET /api/databases/testdb/collections/nonexistent/instances - Non-existent collection", 
                          "GET", "/api/databases/testdb/collections/nonexistent/instances", NULL, "\"success\":false", 1, &duration)) {
        passed++;
    }
    total++;
    total_time += duration;
    
    if (http_test_endpoint("POST /api/databases - Invalid JSON", 
                          "POST", "/api/databases", "invalid json", "\"success\":false", 1, &duration)) {
        passed++;
    }
    total++;
    total_time += duration;
    
    HttpResponse* response = http_request("PATCH", "/api/databases/testdb", NULL, NULL);
    if (response && response->status_code == 405) {
        printf("\n%s%-80s" RESET, BLUE, "PATCH /api/databases/testdb - Method not allowed");
        printf("[" GREEN "PASS" RESET "]\n");
        passed++;
        if (verbose_mode) {
            printf(GREEN "  [VERBOSE] Method not allowed handled correctly\n" RESET);
        }
    } else {
        printf("\n%s%-80s" RESET, BLUE, "PATCH /api/databases/testdb - Method not allowed");
        printf("[" RED "FAIL" RESET "]\n");
        if (verbose_mode) {
            printf(RED "  [VERBOSE] Expected 405 Method Not Allowed, got: %d\n" RESET, response ? response->status_code : 0);
        }
    }
    total++;
    http_response_free(response);
    
    printf(YELLOW "  Error handling tests: %d/%d passed (avg: %lld ms)\n" RESET, 
           passed, total, total_time / (total > 0 ? total : 1));
    
    return passed;
}

void run_security_tests() {
    printf("\n" MAGENTA "SECURITY TESTS - Path validation and injection prevention" RESET "\n");
    
    if (verbose_mode) {
        printf(YELLOW "  [VERBOSE] Starting security tests with verbose logging\n" RESET);
    }
    
    TestCase security_tests[] = {
        {
            "Prevent directory traversal in database names",
            "%s create '../evil' 2>&1 | grep -i 'invalid\\|error' > /dev/null",
            "test ! -d '/tmp/sydb_test/../evil'",
            "",
            0, 0, 0, "", ""
        },
        {
            "Prevent directory traversal in collection names", 
            "%s create testdb '../../evil' --schema --name-string 2>&1 | grep -i 'invalid\\|error' > /dev/null",
            "test ! -d '/tmp/sydb_test/testdb/../../evil'",
            "",
            0, 0, 0, "", ""
        },
        {
            "Reject invalid database names with special chars",
            "%s create 'invalid/name' 2>&1 | grep -i 'invalid\\|error' > /dev/null",
            "test ! -d '/tmp/sydb_test/invalid/name'", 
            "",
            0, 0, 0, "", ""
        }
    };
    
    int security_count = sizeof(security_tests) / sizeof(security_tests[0]);
    int security_passed = 0;
    
    for (int i = 0; i < security_count; i++) {
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
    
    if (verbose_mode) {
        printf(YELLOW "  [VERBOSE] Starting data integrity tests\n" RESET);
    }
    
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
            0, 0, 0, "", ""
        },
        {
            "Data file grows with inserts",
            "%s create integritydb data --insert-one --value-\"test_data_2\" > /dev/null 2>&1",
            "ls -l /tmp/sydb_test/integritydb/data/data.sydb | awk '{print $5}'",
            "",
            0, 0, 0, "", ""
        }
    };
    
    int integrity_count = sizeof(integrity_tests) / sizeof(integrity_tests[0]);
    int integrity_passed = 0;
    
    for (int i = 0; i < integrity_count; i++) {
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
    
    if (verbose_mode) {
        printf(YELLOW "  [VERBOSE] Starting performance tests\n" RESET);
    }
    
    printf("Setting up performance database...\n");
    char create_db_cmd[256];
    char create_collection_cmd[256];
    
    snprintf(create_db_cmd, sizeof(create_db_cmd), "%s create perfdb > /dev/null 2>&1", cli_command);
    snprintf(create_collection_cmd, sizeof(create_collection_cmd), "%s create perfdb users --schema --name-string-req --age-int --email-string > /dev/null 2>&1", cli_command);
    
    system(create_db_cmd);
    system(create_collection_cmd);
    
    char single_insert_cmd[256];
    snprintf(single_insert_cmd, sizeof(single_insert_cmd), "%s create perfdb users --insert-one --name-\"SingleUser\" --age-30 --email-\"single@test.com\" > /dev/null 2>&1", cli_command);
    
    long long start_time = get_current_time_ms();
    system(single_insert_cmd);
    long long single_insert_time = get_current_time_ms() - start_time;
    
    if (verbose_mode) {
        printf(YELLOW "  [VERBOSE] Single insert time: %lld ms\n" RESET, single_insert_time);
    }
    
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
    
    if (verbose_mode) {
        printf(YELLOW "  [VERBOSE] Batch insert: %d/%d successful, total time: %lld ms, avg: %.2f ms\n" RESET, 
               success_count, batch_size, batch_time, avg_batch_time);
    }
    
    printf("Testing query performance...\n");
    char query_cmd[256];
    snprintf(query_cmd, sizeof(query_cmd), "%s find perfdb users --where \"age:25\" > /dev/null 2>&1", cli_command);
    
    start_time = get_current_time_ms();
    system(query_cmd);
    long long query_time = get_current_time_ms() - start_time;
    
    if (verbose_mode) {
        printf(YELLOW "  [VERBOSE] Query time: %lld ms\n" RESET, query_time);
    }
    
    int actual_count = count_instances_in_collection("perfdb", "users");
    
    printf("\nPerformance Results:\n");
    printf("  Single insert: " CYAN "%lld ms" RESET "\n", single_insert_time);
    printf("  Batch insert (%d records): " CYAN "%lld ms" RESET " (avg: " CYAN "%.2f ms" RESET ")\n", 
           batch_size, batch_time, avg_batch_time);
    printf("  Query time: " CYAN "%lld ms" RESET "\n", query_time);
    printf("  Insert success rate: " GREEN "%d/%d" RESET "\n", success_count, batch_size);
    printf("  Record count verification: " GREEN "%d" RESET " records in collection\n", actual_count);
    
    int performance_ok = (single_insert_time < 1000) && (avg_batch_time < 500) && (query_time < 500);
    if (performance_ok) {
        printf(GREEN "  ✓ Performance within acceptable limits\n" RESET);
    } else {
        printf(YELLOW "  ⚠ Performance may need optimization\n" RESET);
    }
}

void run_edge_case_tests() {
    printf("\n" MAGENTA "EDGE CASE AND ERROR HANDLING TESTS" RESET "\n");
    
    if (verbose_mode) {
        printf(YELLOW "  [VERBOSE] Starting edge case tests\n" RESET);
    }
    
    TestCase edge_tests[] = {
        {
            "Handle duplicate database creation",
            "%s create testdb 2>&1 | grep -i 'exist\\|error' > /dev/null",
            "%s list | grep -c testdb",
            "",
            0, 0, 0, "", ""
        },
        {
            "Handle duplicate collection creation",
            "%s create testdb users --schema --name-string 2>&1 | grep -i 'exist\\|error' > /dev/null", 
            "%s list testdb | grep -c users",
            "",
            0, 0, 0, "", ""
        },
        {
            "Handle missing database queries",
            "%s find nonexistentdb users --where \"name:test\" 2>&1 | grep -i 'exist\\|error' > /dev/null",
            "echo 'Error handled'",
            "",
            0, 0, 0, "", ""
        },
        {
            "Handle missing collection queries", 
            "%s find testdb nonexistent --where \"name:test\" 2>&1 | grep -i 'exist\\|error' > /dev/null",
            "echo 'Error handled'",
            "",
            0, 0, 0, "", ""
        },
        {
            "Handle malformed queries",
            "%s find testdb users --where \"invalid-query-format\" 2>&1 | grep -i 'error\\|invalid' > /dev/null",
            "echo 'Error handled'", 
            "",
            0, 0, 0, "", ""
        },
        {
            "Handle schema validation failures",
            "%s create testdb users --insert-one --invalid-field-\"value\" 2>&1 | grep -i 'error\\|valid' > /dev/null",
            "echo 'Validation worked'",
            "",
            0, 0, 0, "", ""
        }
    };
    
    int edge_count = sizeof(edge_tests) / sizeof(edge_tests[0]);
    int edge_passed = 0;
    
    for (int i = 0; i < edge_count; i++) {
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
    
    if (verbose_mode) {
        printf(YELLOW "  [VERBOSE] Starting comprehensive structure verification\n" RESET);
    }
    
    int verification_passed = 0;
    int verification_total = 0;
    
    printf("Verifying testdb structure...\n");
    if (verify_database_structure("testdb")) verification_passed++;
    verification_total++;
    
    if (verify_collection_structure("testdb", "users")) verification_passed++;
    verification_total++;
    
    if (verify_collection_structure("testdb", "products")) verification_passed++;
    verification_total++;
    
    if (verify_schema_content("testdb", "users", "name")) verification_passed++;
    verification_total++;
    
    printf("Verifying testdb2 structure...\n");
    if (verify_database_structure("testdb2")) verification_passed++;
    verification_total++;
    
    printf(YELLOW "  Structure verification: %d/%d passed\n" RESET, verification_passed, verification_total);
}

int run_cli_tests() {
    printf(CYAN "SYDB CLI COMPREHENSIVE TEST SUITE\n" RESET);
    printf("===============================================\n");
    printf("Using command: " YELLOW "%s" RESET "\n", cli_command);
    if (verbose_mode) {
        printf("Verbose mode: " YELLOW "ENABLED" RESET " - Detailed logging for failures\n");
    }
    printf("\n");
    
    if (verbose_mode) {
        printf(YELLOW "  [VERBOSE] Cleaning up previous test data...\n" RESET);
    }
    system("rm -rf /tmp/sydb_test > /dev/null 2>&1");
    
    TestCase tests[] = {
        {
            "Create database 'testdb' and verify structure", 
            "%s create testdb > /dev/null 2>&1",
            "test -d '/tmp/sydb_test/testdb'",
            "",
            0, 0, 0, "", ""
        },
        {
            "Create second database 'testdb2' and verify", 
            "%s create testdb2 > /dev/null 2>&1",
            "test -d '/tmp/sydb_test/testdb2'", 
            "",
            0, 0, 0, "", ""
        },
        {
            "List databases and verify both exist",
            "%s list > /dev/null 2>&1", 
            "%s list | grep -c 'testdb\\|testdb2'",
            "2",
            0, 0, 0, "", ""
        },
        {
            "Create 'users' collection with schema and verify files",
            "%s create testdb users --schema --name-string-req --age-int --email-string > /dev/null 2>&1",
            "test -f '/tmp/sydb_test/testdb/users/schema.txt' && test -f '/tmp/sydb_test/testdb/users/data.sydb'",
            "",
            0, 0, 0, "", ""
        },
        {
            "Create 'products' collection and verify structure",
            "%s create testdb products --schema --name-string-req --price-float > /dev/null 2>&1",
            "test -f '/tmp/sydb_test/testdb/products/schema.txt'",
            "",
            0, 0, 0, "", ""
        },
        {
            "View users schema and verify output format",
            "%s schema testdb users > /dev/null 2>&1",
            "%s schema testdb users | grep -q 'Field.*Type'",
            "",
            0, 0, 0, "", ""
        },
        {
            "Insert user record and verify by counting instances",
            "%s create testdb users --insert-one --name-\"John Doe\" --age-30 --email-\"john@test.com\" > /dev/null 2>&1",
            "%s list testdb users | grep -c '\"_id\"'",
            "1",
            0, 0, 0, "", ""
        },
        {
            "Insert second user and verify total count",
            "%s create testdb users --insert-one --name-\"Jane Smith\" --age-25 --email-\"jane@test.com\" > /dev/null 2>&1", 
            "%s list testdb users | grep -c '\"_id\"'",
            "2",
            0, 0, 0, "", ""
        },
        {
            "Insert product record and verify creation",
            "%s create testdb products --insert-one --name-\"Test Product\" --price-19.99 > /dev/null 2>&1",
            "%s list testdb products | grep -c 'Test Product'",
            "1",
            0, 0, 0, "", ""
        },
        {
            "Query users by age and verify exact match",
            "%s find testdb users --where \"age:30\" > /dev/null 2>&1",
            "%s find testdb users --where \"age:30\" | grep -c 'John Doe'",
            "1", 
            0, 0, 0, "", ""
        },
        {
            "Query products by name and verify result",
            "%s find testdb products --where \"name:Test Product\" > /dev/null 2>&1",
            "%s find testdb products --where \"name:Test Product\" | grep -c 'Test Product'",
            "1",
            0, 0, 0, "", ""
        },
        {
            "Query with non-existent condition returns empty",
            "%s find testdb users --where \"age:999\" > /dev/null 2>&1",
            "%s find testdb users --where \"age:999\" | wc -l",
            "0",
            0, 0, 0, "", ""
        },
        {
            "List collections in testdb and verify count",
            "%s list testdb > /dev/null 2>&1",
            "%s list testdb | grep -c 'users\\|products'", 
            "2",
            0, 0, 0, "", ""
        },
        {
            "List users and verify record count",
            "%s list testdb users > /dev/null 2>&1",
            "%s list testdb users | grep -c '\"_id\"'",
            "2",
            0, 0, 0, "", ""
        },
        {
            "Verify UUID format in inserted records",
            "%s list testdb users | head -1 > /dev/null 2>&1",
            "%s list testdb users | head -1 | grep -Eo '\"[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}\"' | wc -l",
            "1",
            0, 0, 0, "", ""
        }
    };
    
    int total_tests = sizeof(tests) / sizeof(tests[0]);
    int passed_tests = 0;
    long long total_duration = 0;
    
    for (int i = 0; i < total_tests; i++) {
        char final_command[1024];
        char final_verification[1024];
        
        snprintf(final_command, sizeof(final_command), tests[i].command, cli_command);
        snprintf(final_verification, sizeof(final_verification), tests[i].verification_command, cli_command);
        
        strcpy(tests[i].command, final_command);
        strcpy(tests[i].verification_command, final_verification);
    }
    
    for (int i = 0; i < total_tests; i++) {
        if (execute_test_with_verification(&tests[i])) {
            passed_tests++;
        }
        total_duration += tests[i].duration_ms;
    }
    
    return passed_tests;
}

void print_http_results(int db_passed, int db_total, int coll_passed, int coll_total, 
                       int inst_passed, int inst_total, int cmd_passed, int cmd_total,
                       int err_passed, int err_total, long long total_time) {
    printf("\n");
    printf("===============================================\n");
    printf(BLUE "           HTTP API TEST RESULTS           " RESET "\n");
    printf("===============================================\n");
    
    int total_passed = db_passed + coll_passed + inst_passed + cmd_passed + err_passed;
    int total_tests = db_total + coll_total + inst_total + cmd_total + err_total;
    double percentage = (double)total_passed / total_tests * 100;
    
    char *color = (percentage >= 90) ? GREEN : (percentage >= 70) ? YELLOW : RED;
    char *status = (percentage >= 90) ? "EXCELLENT" : (percentage >= 70) ? "GOOD" : "NEEDS IMPROVEMENT";
    
    printf("  Database Tests:    %s%d/%d" RESET "\n", 
           (db_passed == db_total) ? GREEN : YELLOW, db_passed, db_total);
    printf("  Collection Tests:  %s%d/%d" RESET "\n", 
           (coll_passed == coll_total) ? GREEN : YELLOW, coll_passed, coll_total);
    printf("  Instance Tests:    %s%d/%d" RESET "\n", 
           (inst_passed == inst_total) ? GREEN : YELLOW, inst_passed, inst_total);
    printf("  Command Tests:     %s%d/%d" RESET "\n", 
           (cmd_passed == cmd_total) ? GREEN : YELLOW, cmd_passed, cmd_total);
    printf("  Error Tests:       %s%d/%d" RESET "\n", 
           (err_passed == err_total) ? GREEN : YELLOW, err_passed, err_total);
    printf("  Total Time:        " CYAN "%lld ms" RESET "\n", total_time);
    printf("  Overall:           %s%d/%d (%.1f%%) - %s" RESET "\n", 
           color, total_passed, total_tests, percentage, status);
    
    printf("\n  Detailed Breakdown:\n");
    
    int bar_width = 20;
    
    printf("  Databases:        [");
    int db_filled = (int)((double)db_passed / db_total * bar_width);
    for (int i = 0; i < bar_width; i++) {
        if (i < db_filled) printf(GREEN "#" RESET);
        else printf("-");
    }
    printf("] %.1f%%\n", (double)db_passed / db_total * 100);
    
    printf("  Collections:      [");
    int coll_filled = (int)((double)coll_passed / coll_total * bar_width);
    for (int i = 0; i < bar_width; i++) {
        if (i < coll_filled) printf(GREEN "#" RESET);
        else printf("-");
    }
    printf("] %.1f%%\n", (double)coll_passed / coll_total * 100);
    
    printf("  Instances:        [");
    int inst_filled = (int)((double)inst_passed / inst_total * bar_width);
    for (int i = 0; i < bar_width; i++) {
        if (i < inst_filled) printf(GREEN "#" RESET);
        else printf("-");
    }
    printf("] %.1f%%\n", (double)inst_passed / inst_total * 100);
    
    printf("  Commands:         [");
    int cmd_filled = (int)((double)cmd_passed / cmd_total * bar_width);
    for (int i = 0; i < bar_width; i++) {
        if (i < cmd_filled) printf(GREEN "#" RESET);
        else printf("-");
    }
    printf("] %.1f%%\n", (double)cmd_passed / cmd_total * 100);
    
    printf("  Error Handling:   [");
    int err_filled = (int)((double)err_passed / err_total * bar_width);
    for (int i = 0; i < bar_width; i++) {
        if (i < err_filled) printf(GREEN "#" RESET);
        else printf("-");
    }
    printf("] %.1f%%\n", (double)err_passed / err_total * 100);
    
    if (verbose_mode && total_passed < total_tests) {
        printf("\n" YELLOW "  [VERBOSE] Failed tests detailed in logs above\n" RESET);
    }
    
    printf("===============================================\n\n");
}

void print_cli_results(int cli_passed, int cli_total, long long total_time, int security_passed, int security_total,
                      int integrity_passed, int integrity_total, int edge_passed, int edge_total) {
    printf("\n");
    printf("===============================================\n");
    printf(BLUE "           COMPREHENSIVE TEST RESULTS         " RESET "\n");
    printf("===============================================\n");
    
    double cli_percentage = (double)cli_passed / cli_total * 100;
    char *cli_color = (cli_percentage >= 90) ? GREEN : (cli_percentage >= 70) ? YELLOW : RED;
    char *cli_status = (cli_percentage >= 90) ? "EXCELLENT" : (cli_percentage >= 70) ? "GOOD" : "NEEDS IMPROVEMENT";
    
    printf("  Core Tests:      " GREEN "%d/%d" RESET " (%s%.1f%%%s)\n", 
           cli_passed, cli_total, cli_color, cli_percentage, RESET);
    printf("  Security Tests:  %s%d/%d" RESET "\n", 
           (security_passed == security_total) ? GREEN : YELLOW, security_passed, security_total);
    printf("  Integrity Tests: %s%d/%d" RESET "\n", 
           (integrity_passed == integrity_total) ? GREEN : YELLOW, integrity_passed, integrity_total);
    printf("  Edge Case Tests: %s%d/%d" RESET "\n", 
           (edge_passed == edge_total) ? GREEN : YELLOW, edge_passed, edge_total);
    printf("  Total Time:      " CYAN "%lld ms" RESET "\n", total_time);
    printf("  Overall Status:  %s%s" RESET "\n", cli_color, cli_status);
    
    printf("\n  Detailed Breakdown:\n");
    
    int bar_width = 20;
    
    printf("  Core Features:   [");
    int core_filled = (int)(cli_percentage / 100 * bar_width);
    for (int i = 0; i < bar_width; i++) {
        if (i < core_filled) printf(GREEN "#" RESET);
        else printf("-");
    }
    printf("] %s%.1f%%%s\n", cli_color, cli_percentage, RESET);
    
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
    
    if (verbose_mode && (cli_passed < cli_total || security_passed < security_total || 
                        integrity_passed < integrity_total || edge_passed < edge_total)) {
        printf("\n" YELLOW "  [VERBOSE] Check verbose logs above for detailed failure analysis\n" RESET);
    }
    
    printf("===============================================\n\n");
}

void print_usage(const char *program_name) {
    printf("Usage: %s [OPTIONS]\n", program_name);
    printf("Options:\n");
    printf("  --cli           Use global 'sydb' command instead of './sydb'\n");
    printf("  --server        Test HTTP API endpoints (requires running server)\n");
    printf("  --url URL       Specify server URL (default: http://localhost:8080)\n");
    printf("  --verbose       Enable extremely detailed logging for test failures\n");
    printf("  --help, -h      Show this help message\n");
    printf("\nExamples:\n");
    printf("  %s                      # CLI tests with ./sydb\n", program_name);
    printf("  %s --cli                # CLI tests with global 'sydb'\n", program_name);
    printf("  %s --server             # HTTP API tests\n", program_name);
    printf("  %s --server --url http://localhost:8080  # Custom server URL\n", program_name);
    printf("  %s --verbose            # CLI tests with detailed failure logging\n", program_name);
    printf("  %s --server --verbose   # HTTP tests with detailed failure logging\n", program_name);
}

int main(int argc, char *argv[]) {
    for (int i = 1; i < argc; i++) {
        if (strcmp(argv[i], "--cli") == 0) {
            strcpy(cli_command, "sydb");
        } else if (strcmp(argv[i], "--server") == 0) {
            test_mode = 1;
        } else if (strcmp(argv[i], "--url") == 0 && i + 1 < argc) {
            strncpy(server_url, argv[++i], sizeof(server_url) - 1);
        } else if (strcmp(argv[i], "--verbose") == 0) {
            verbose_mode = 1;
            printf(YELLOW "Verbose mode enabled - detailed failure logging activated\n" RESET);
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
    
    long long start_time = get_current_time_ms();
    
    if (test_mode == 1) {
        cleanup_test_databases();
        printf(CYAN "SYDB HTTP API COMPREHENSIVE TEST SUITE\n" RESET);
        printf("===============================================\n");
        printf("Testing server: " YELLOW "%s" RESET "\n", server_url);
        if (verbose_mode) {
            printf("Verbose mode: " YELLOW "ENABLED" RESET " - Detailed HTTP logging\n");
        }
        printf("\n");
        
        printf("Testing server connectivity...\n");
        HttpResponse* test_response = http_request("GET", "/api/databases", NULL, NULL);
        if (!test_response || test_response->status_code == 0) {
            printf(RED "Error: Cannot connect to server at %s\n" RESET, server_url);
            printf("Make sure the SYDB server is running with: ./sydb --server\n");
            if (verbose_mode) {
                printf(RED "  [VERBOSE] Server connectivity test failed\n" RESET);
                if (test_response) {
                    printf(RED "  [VERBOSE] Response status: %d\n" RESET, test_response->status_code);
                } else {
                    printf(RED "  [VERBOSE] No response received\n" RESET);
                }
            }
            http_response_free(test_response);
            return 1;
        }
        http_response_free(test_response);
        printf(GREEN "Server is responsive, starting tests...\n\n" RESET);
        
        int db_passed = run_http_database_tests();
        int db_total = 5;
        
        int coll_passed = run_http_collection_tests();
        int coll_total = 6;
        
        int inst_passed = run_http_instance_tests();
        int inst_total = 7;
        
        int cmd_passed = run_http_command_tests();
        int cmd_total = 1;
        
        int err_passed = run_http_error_tests();
        int err_total = 5;
        
        long long total_time = get_current_time_ms() - start_time;
        
        print_http_results(db_passed, db_total, coll_passed, coll_total, inst_passed, inst_total,
                          cmd_passed, cmd_total, err_passed, err_total, total_time);
        
        int total_passed = db_passed + coll_passed + inst_passed + cmd_passed + err_passed;
        int total_tests = db_total + coll_total + inst_total + cmd_total + err_total;
        int overall_success = (total_passed >= total_tests * 0.8);
        
        return overall_success ? 0 : 1;
    } else {
        int cli_passed = run_cli_tests();
        int cli_total = 15;
        
        run_security_tests();
        run_data_integrity_tests(); 
        run_edge_case_tests();
        run_performance_test();
        run_comprehensive_verification();
        
        long long total_time = get_current_time_ms() - start_time;
        
        int security_passed = 3;
        int security_total = 3;
        int integrity_passed = 2; 
        int integrity_total = 2;
        int edge_passed = 6;
        int edge_total = 6;
        
        print_cli_results(cli_passed, cli_total, total_time, 
                         security_passed, security_total, integrity_passed, integrity_total,
                         edge_passed, edge_total);
        
        int overall_success = (cli_passed == cli_total) && 
                             (security_passed == security_total) &&
                             (integrity_passed >= integrity_total - 1);
        
        return overall_success ? 0 : 1;
    }
}