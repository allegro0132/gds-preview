import sys
import os
import importlib.util

# This script acts as a dispatcher for the PyInstaller-bundled executable.
# Usage: ./engine_entry <script_name> <args...>
# Example: ./engine_entry gds_to_canvas file.gds ...

def run_script(script_name, args):
    # Determine the path to the script. 
    # When frozen (PyInstaller), we might need to rely on importing modules 
    # if we bundled them, or running code directly.
    # To keep it simple and consistent with existing code structure, 
    # we will import the module dynamically.
    
    # In PyInstaller --onefile or --onedir mode, we include these modules.
    try:
        # We need to map the script name to the module name
        # gds_to_canvas.py -> gds_to_canvas
        module_name = os.path.splitext(script_name)[0]
        
        # We assume the modules are available in the path (bundled)
        if module_name == 'gds_to_canvas':
            import gds_to_canvas as target_module
        elif module_name == 'gds_to_svg':
            import gds_to_svg as target_module
        else:
            print(f"Error: Unknown script {script_name}", file=sys.stderr)
            return

        # Modify sys.argv so the target script sees the expected arguments
        # Original argv: [engine_entry, script_name, arg1, arg2...]
        # Target argv:   [script_name, arg1, arg2...]
        sys.argv = [script_name] + args
        
        # Execute the module's main logic
        # Since your scripts likely run code under "if __name__ == '__main__':",
        # importing might not run it. We need to check if we need to call a function
        # or if the code is at the top level.
        # Given typical script structure, it's safer to exec/run the file if possible,
        # but in a frozen environment, 'runpy' is the standard pythonic way.
        
        import runpy
        # runpy.run_module(module_name, run_name="__main__")
        # However, since we are inside the frozen exe, imports are best.
        
        # Let's inspect the target files first to see how to invoke them.
        # If they use "if __name__ == '__main__': main()", we can call main().
        # If they act as scripts, we might need a slight refactor or just runpy.
        pass

    except ImportError as e:
        print(f"Error importing {module_name}: {e}", file=sys.stderr)
    except Exception as e:
        print(f"Error executing {module_name}: {e}", file=sys.stderr)

if __name__ == "__main__":
    if len(sys.argv) < 2:
        print("Usage: engine <script_name> [args...]", file=sys.stderr)
        sys.exit(1)

    script_to_run = sys.argv[1]
    script_args = sys.argv[2:]
    
    # Map script filenames to module names
    if script_to_run == 'gds_to_canvas.py':
        import gds_to_canvas
        sys.argv = [script_to_run] + script_args
        if hasattr(gds_to_canvas, 'main'):
            gds_to_canvas.main()
        else:
            # Fallback for script-level execution
            # This is tricky in frozen, easiest is to ensure scripts have a main()
            pass
            
    elif script_to_run == 'gds_to_svg.py':
        import gds_to_svg
        sys.argv = [script_to_run] + script_args
        if hasattr(gds_to_svg, 'main'):
            gds_to_svg.main()
        else:
            pass
    else:
        print(f"Unknown script: {script_to_run}", file=sys.stderr)
        sys.exit(1)
