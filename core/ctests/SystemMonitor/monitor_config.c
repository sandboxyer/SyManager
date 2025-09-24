#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <unistd.h>
#include <time.h>
#include <sys/stat.h>
#include <fcntl.h>
#include <sys/file.h>
#include <termios.h>
#include <signal.h>
#include <sys/ioctl.h>

#define CONFIG_FILE "/etc/system_monitor.conf"
#define STATS_FILE "/tmp/system_monitor_stats"

typedef enum {
    EVENT_LOGIN,
    EVENT_LOGOUT,
    EVENT_SSH,
    EVENT_FILE_MOVE,
    EVENT_FILE_EDIT,
    EVENT_FILE_CREATE,
    EVENT_FILE_DELETE,
    EVENT_NETWORK,
    EVENT_PROCESS,
    EVENT_OTHERS,
    EVENT_COUNT
} event_type_t;

const char* event_type_names[] = {
    "LOGIN", "LOGOUT", "SSH", "FILE_MOVE", "FILE_EDIT", 
    "FILE_CREATE", "FILE_DELETE", "NETWORK", "PROCESS", "OTHERS"
};

typedef struct {
    int events_second[EVENT_COUNT];
    int events_minute[EVENT_COUNT];
    int total_events;
    time_t last_update;
} stats_t;

int filters[EVENT_COUNT];
stats_t stats;
int running = 1;
time_t last_display_update = 0;
struct termios original_termios;

void enable_raw_mode() {
    struct termios term;
    tcgetattr(STDIN_FILENO, &term);
    original_termios = term;
    term.c_lflag &= ~(ICANON | ECHO);
    tcsetattr(STDIN_FILENO, TCSANOW, &term);
}

void disable_raw_mode() {
    tcsetattr(STDIN_FILENO, TCSANOW, &original_termios);
}

void clear_screen() {
    // Clear screen and move cursor to top-left
    printf("\033[2J\033[H");
}

void move_cursor_top() {
    printf("\033[H");
}

void erase_to_end_of_line() {
    printf("\033[K");
}

void load_config() {
    int config_fd = open(CONFIG_FILE, O_RDONLY);
    if (config_fd == -1) {
        return;
    }
    
    if (flock(config_fd, LOCK_SH) == -1) {
        close(config_fd);
        return;
    }
    
    FILE *config = fdopen(config_fd, "r");
    if (!config) {
        close(config_fd);
        return;
    }
    
    char line[256];
    while (fgets(line, sizeof(line), config)) {
        if (line[0] == '#' || line[0] == '\n') continue;
        
        char *key = strtok(line, "=");
        char *value = strtok(NULL, "\n");
        
        if (key && value) {
            key = strtok(key, " \t");
            value = strtok(value, " \t");
            
            if (key && value) {
                for (int i = 0; i < EVENT_COUNT; i++) {
                    if (strcasecmp(key, event_type_names[i]) == 0) {
                        filters[i] = (strcasecmp(value, "enable") == 0) ? 1 : 0;
                        break;
                    }
                }
            }
        }
    }
    
    fclose(config);
}

void save_config() {
    int config_fd = open(CONFIG_FILE, O_WRONLY | O_CREAT | O_TRUNC, 0644);
    if (config_fd == -1) {
        return;
    }
    
    if (flock(config_fd, LOCK_EX) == -1) {
        close(config_fd);
        return;
    }
    
    FILE *config = fdopen(config_fd, "w");
    if (!config) {
        close(config_fd);
        return;
    }
    
    fprintf(config, "# System Monitor Configuration\n");
    fprintf(config, "# Use 'enable' or 'disable' for each event type\n\n");
    
    for (int i = 0; i < EVENT_COUNT; i++) {
        fprintf(config, "%s=%s\n", event_type_names[i], filters[i] ? "enable" : "disable");
    }
    
    fclose(config);
}

void load_stats() {
    FILE *stats_file = fopen(STATS_FILE, "r");
    if (stats_file) {
        fread(&stats, sizeof(stats), 1, stats_file);
        fclose(stats_file);
    }
}

void print_header() {
    time_t now = time(NULL);
    char timestamp[64];
    struct tm *tm_info = localtime(&now);
    strftime(timestamp, sizeof(timestamp), "%H:%M:%S", tm_info);
    
    printf("=== System Monitor Configuration Interface ===\n");
    printf("Last Update: %s | Total Events: %d\n", timestamp, stats.total_events);
    erase_to_end_of_line();
    printf("\n");
}

void print_filters() {
    printf("Event Filters (Press number to toggle, 's' to save, 'q' to quit):\n");
    printf("┌──────────────────────┬──────────┬─────────────┬─────────────┐\n");
    printf("│ Event Type           │ Status   │ Events/Sec  │ Events/Min  │\n");
    printf("├──────────────────────┼──────────┼─────────────┼─────────────┤\n");
    
    int total_second = 0;
    int total_minute = 0;
    
    for (int i = 0; i < EVENT_COUNT; i++) {
        printf("│ %2d. %-16s │ %-8s │ %11d │ %11d │\n", 
               i + 1, event_type_names[i], 
               filters[i] ? "ENABLED" : "DISABLED",
               stats.events_second[i],
               stats.events_minute[i]);
        erase_to_end_of_line();
        
        total_second += stats.events_second[i];
        total_minute += stats.events_minute[i];
    }
    printf("├──────────────────────┼──────────┼─────────────┼─────────────┤\n");
    printf("│ TOTAL                │          │ %11d │ %11d │\n", total_second, total_minute);
    erase_to_end_of_line();
    printf("└──────────────────────┴──────────┴─────────────┴─────────────┘\n");
    erase_to_end_of_line();
}

void print_event_rates() {
    printf("\nActive Events (last second):\n");
    erase_to_end_of_line();
    int any_events = 0;
    
    for (int i = 0; i < EVENT_COUNT; i++) {
        if (stats.events_second[i] > 0) {
            printf("  %s: %d/sec", event_type_names[i], stats.events_second[i]);
            if (stats.events_minute[i] > 0) {
                printf(" (%d/min)", stats.events_minute[i]);
            }
            printf("\n");
            erase_to_end_of_line();
            any_events = 1;
        }
    }
    
    if (!any_events) {
        printf("  No active events\n");
        erase_to_end_of_line();
    }
}

void print_commands() {
    printf("\nCommands: 1-9: Toggle events | 0: Toggle OTHERS | A: Toggle all | S: Save | Q: Quit\n");
    erase_to_end_of_line();
    printf("> ");
    erase_to_end_of_line();
    fflush(stdout);
}

void update_display() {
    time_t now = time(NULL);
    
    // Only update display once per second to prevent flickering
    if (now - last_display_update < 1) {
        return;
    }
    
    last_display_update = now;
    
    // Clear screen and redraw everything
    clear_screen();
    print_header();
    print_filters();
    print_event_rates();
    print_commands();
}

void show_save_message() {
    // Save the current cursor position
    printf("\033[s");
    
    // Move to bottom and show message
    printf("\033[20H"); // Move to line 20
    erase_to_end_of_line();
    printf("✓ Configuration saved! Press any key to continue...");
    fflush(stdout);
    
    // Wait for key press
    getchar();
    
    // Restore cursor position and clear the message
    printf("\033[u");
    erase_to_end_of_line();
    printf("\033[20H");
    erase_to_end_of_line();
}

void signal_handler(int sig) {
    running = 0;
}

int main() {
    printf("Loading System Monitor Configuration Interface...\n");
    
    // Initialize filters - disable file events by default
    for (int i = 0; i < EVENT_COUNT; i++) {
        if (i == EVENT_FILE_MOVE || i == EVENT_FILE_EDIT || 
            i == EVENT_FILE_CREATE || i == EVENT_FILE_DELETE) {
            filters[i] = 0;
        } else {
            filters[i] = 1;
        }
    }
    
    load_config();
    
    signal(SIGINT, signal_handler);
    signal(SIGTERM, signal_handler);
    
    enable_raw_mode();
    
    printf("Press any key to start real-time monitoring...");
    fflush(stdout);
    getchar();
    
    // Initial clear and display
    clear_screen();
    last_display_update = 0; // Force immediate update
    
    while (running) {
        load_config();
        load_stats();
        update_display();
        
        struct timeval timeout;
        timeout.tv_sec = 0;
        timeout.tv_usec = 100000; // 100ms for responsive input
        
        fd_set read_fds;
        FD_ZERO(&read_fds);
        FD_SET(STDIN_FILENO, &read_fds);
        
        int ready = select(STDIN_FILENO + 1, &read_fds, NULL, NULL, &timeout);
        
        if (ready > 0) {
            char input = getchar();
            
            if (input >= '1' && input <= '9') {
                int index = input - '1';
                if (index < EVENT_COUNT) {
                    filters[index] = !filters[index];
                    save_config();
                    last_display_update = 0; // Force immediate display update
                }
            } else if (input == '0') {
                filters[EVENT_COUNT-1] = !filters[EVENT_COUNT-1];
                save_config();
                last_display_update = 0; // Force immediate display update
            } else if (input == 's' || input == 'S') {
                save_config();
                show_save_message();
                last_display_update = 0; // Force display update after message
            } else if (input == 'q' || input == 'Q') {
                break;
            } else if (input == 'a' || input == 'A') {
                int all_enabled = 1;
                for (int i = 0; i < EVENT_COUNT; i++) {
                    if (!filters[i]) {
                        all_enabled = 0;
                        break;
                    }
                }
                
                for (int i = 0; i < EVENT_COUNT; i++) {
                    filters[i] = !all_enabled;
                }
                save_config();
                last_display_update = 0; // Force immediate display update
            }
        }
        
        // Small delay to prevent CPU spinning
        usleep(10000); // 10ms
    }
    
    disable_raw_mode();
    clear_screen();
    printf("Configuration interface closed.\n");
    
    return 0;
}
