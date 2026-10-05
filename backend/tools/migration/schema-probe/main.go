// Command schema-probe reports whether a named collection carries a field.
//
// It exists to answer one question that cannot be asked over HTTP: the admin
// collection routes need a superuser token, and the question being asked here —
// "did migration N actually reach this pb_data?" — is precisely the one you
// need answered when the server is refusing to start or a field is missing.
//
//	go run ./tools/migration/schema-probe -data pb_data -collection posts -field author_character_id
package main

import (
	"flag"
	"fmt"
	"os"

	"github.com/pocketbase/pocketbase/core"
	_ "github.com/pocketbase/pocketbase/migrations"

	_ "github.com/SiJunma/aerun/backend/internal/migrations"
)

func main() {
	data := flag.String("data", "pb_data", "path to the PocketBase data directory")
	collection := flag.String("collection", "", "collection name or id")
	field := flag.String("field", "", "field name to look for")
	flag.Parse()

	if *collection == "" || *field == "" {
		fmt.Fprintln(os.Stderr, "both -collection and -field are required")
		os.Exit(2)
	}

	app := core.NewBaseApp(core.BaseAppConfig{DataDir: *data})
	if err := app.Bootstrap(); err != nil {
		fmt.Fprintf(os.Stderr, "bootstrap: %v\n", err)
		os.Exit(1)
	}
	defer app.ResetBootstrapState()

	col, err := app.FindCachedCollectionByNameOrId(*collection)
	if err != nil {
		fmt.Fprintf(os.Stderr, "collection %q: %v\n", *collection, err)
		os.Exit(1)
	}

	if col.Fields.GetByName(*field) == nil {
		fmt.Printf("MISSING  %s.%s\n", col.Name, *field)
		os.Exit(1)
	}
	fmt.Printf("PRESENT  %s.%s (%s)\n", col.Name, *field, col.Fields.GetByName(*field).Type())
}
