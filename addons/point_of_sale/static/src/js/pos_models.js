function openerp_pos_models(instance, module){ //module is instance.point_of_sale
    var QWeb = instance.web.qweb;

    module.LocalStorageDAO = instance.web.Class.extend({
        add_operation: function(operation) {
            var self = this;
            return $.async_when().pipe(function() {
                var tmp = self._get('oe_pos_operations', []);
                var last_id = self._get('oe_pos_operations_sequence', 1);
                tmp.push({'id': last_id, 'data': operation});
                self._set('oe_pos_operations', tmp);
                self._set('oe_pos_operations_sequence', last_id + 1);
            });
        },
        remove_operation: function(id) {
            var self = this;
            return $.async_when().pipe(function() {
                var tmp = self._get('oe_pos_operations', []);
                tmp = _.filter(tmp, function(el) {
                    return el.id !== id;
                });
                self._set('oe_pos_operations', tmp);
            });
        },
        get_operations: function() {
            var self = this;
            return $.async_when().pipe(function() {
                return self._get('oe_pos_operations', []);
            });
        },
        _get: function(key, default_) {
            var txt = localStorage['oe_pos_dao_'+key];
            if (! txt)
                return default_;
            return JSON.parse(txt);
        },
        _set: function(key, value) {
            localStorage['oe_pos_dao_'+key] = JSON.stringify(value);
        },
        reset_stored_data: function(){
            for(key in localStorage){
                if(key.indexOf('oe_pos_dao_') === 0){
                    delete localStorage[key];
                }
            }
        },

    });

    var fetch = function(osvModel, fields, domain){
        var dataSetSearch = new instance.web.DataSetSearch(null, osvModel, {}, domain);
        return dataSetSearch.read_slice(fields, 0);
    };
    
    // The PosModel contains the Point Of Sale's representation of the backend.
    // Since the PoS must work in standalone ( Without connection to the server ) 
    // it must contains a representation of the server's PoS backend. 
    // (taxes, product list, configuration options, etc.)  this representation
    // is fetched and stored by the PosModel at the initialisation. 
    // this is done asynchronously, a ready deferred alows the GUI to wait interactively 
    // for the loading to be completed 
    // There is a single instance of the PosModel for each Front-End instance, it is usually called
    // 'pos' and is available to almost all widgets.

    module.PosModel = Backbone.Model.extend({
        initialize: function(session, attributes) {
            Backbone.Model.prototype.initialize.call(this, attributes);
            var  self = this;
            this.dao = new module.LocalStorageDAO();            // used to store the order's data on the Hard Drive
            this.ready = $.Deferred();                          // used to notify the GUI that the PosModel has loaded all resources
            this.flush_mutex = new $.Mutex();                   // used to make sure the orders are sent to the server once at time
            //this.build_tree = _.bind(this.build_tree, this);    // ???
            this.session = session;                 
            this.categories = {};
            this.root_category = null;
            this.weightable_categories = [];                    // a flat list of all categories that directly contain weightable products
            this.barcode_reader = new module.BarcodeReader({'pos': this});  // used to read barcodes
            this.proxy = new module.ProxyDevice();             // used to communicate to the hardware devices via a local proxy

            // pos settings
            this.use_scale              = false;
            this.use_proxy_printer      = false;
            this.use_virtual_keyboard   = false;
            this.use_websql             = false;
            this.use_barcode_scanner    = false;

            // default attributes values. If null, it will be loaded below.
            this.set({
                'nbr_pending_operations': 0,    

                'currency':         {symbol: '$', position: 'after'},
                'shop':             null, 
                'company':          null,
                'user':             null,
                'user_list':        null,
                'cashier':          null,
                'client':         null,

                'orders':           new module.OrderCollection(),
                //this is the product list as seen by the product list widgets, it will change based on the category filters
                'products':         new module.ProductCollection(), 
                'cashRegisters':    null, 

                'product_list':     null,   // the list of all products, does not change. 
                'bank_statements':  null,
                'taxes':            null,
                'pos_session':      null,
                'pos_config':       null,
                'categories':       null,

                'selectedOrder':    undefined,
            });

            this.get('orders').bind('remove', _.bind( this.on_removed_order, this ) );
            
            // We fetch the backend data on the server asynchronously

            var cat_def = fetch('pos.category', ['id','name', 'parent_id', 'child_id', 'to_weight'])
                .pipe(function(result){
                    return self.set({'categories': result});
                });
            
            var prod_def = fetch( 
                'product.product', 
                ['name', 'list_price', 'pos_categ_id', 'taxes_id','product_image_small', 'ean13', 'to_weight', 'uom_id', 'uos_id', 'uos_coeff', 'mes_type'],
                [['pos_categ_id','!=', false]] 
                ).then(function(result){
                    self.set({'product_list': result});
                    console.log('PRODUCTS_DONE');
                });

            var uom_def = fetch(    //unit of measure
                'product.uom',
                null,
                null
                ).then(function(result){
                    self.set({'units': result});
                    var units_by_id = {};
                    for(var i = 0, len = result.length; i < len; i++){
                        units_by_id[result[i].id] = result[i];
                    }
                    self.set({'units_by_id':units_by_id});
                    console.log('UOM_DONE');
                });

            var user_def = fetch(
                'res.users',
                ['name','ean13'],
                [['ean13', '!=', false]]
                ).then(function(result){
                    self.set({'user_list':result});
                    console.log('USERS_DONE');
                });


            // associate the products with their categories
            var prod_process_def = $.when(cat_def, prod_def)
                .pipe(function(){
                    var product_list = self.get('product_list');
                    var categories = self.get('categories');
                    var cat_by_id = {};
                    for(var i = 0; i < categories.length; i++){
                        cat_by_id[categories[i].id] = categories[i];
                    }
                    //set the parent in the category
                    for(var i = 0; i < categories.length; i++){
                        categories[i].parent_category = cat_by_id[categories[i].parent_id[0]];
                    }
                    for(var i = 0; i < product_list.length; i++){
                        product_list[i].pos_category = cat_by_id[product_list[i].pos_categ_id[0]];
                    }
                    console.log('PROD_PROCESS_DONE');
                });

            var tax_def = fetch('account.tax', ['amount','price_include','type'])
                .then(function(result){
                    self.set({'taxes': result});
                    console.log('TAX_DONE');
                });

            var session_def = fetch(    // loading the PoS Session.
                    'pos.session',
                    ['id', 'journal_ids','name','user_id','config_id','start_at','stop_at'],
                    [['state', '=', 'opened'], ['user_id', '=', this.session.uid]]
                ).pipe(function(result) {

                    // some data are associated with the pos session, like the pos config and bank statements.
                    // we must have a valid session before we can read those. 
                    
                    var session_data_def = new $.Deferred();

                    if( result.length !== 0 ) {
                        var pos_session = result[0];

                        self.set({'pos_session': pos_session});

                        var pos_config_def = fetch(
                                'pos.config',
                                ['name','journal_ids','shop_id','journal_id',
                                 'iface_self_checkout', 'iface_websql', 'iface_led', 'iface_cashdrawer',
                                 'iface_payment_terminal', 'iface_electronic_scale', 'iface_barscan', 'iface_vkeyboard',
                                 'iface_print_via_proxy','state','sequence_id','session_ids'],
                                [['id','=', pos_session.config_id[0]]]
                            ).then(function(result){
                                self.set({'pos_config': result[0]});
                                self.use_scale              = result[0].iface_electronic_scale  || false;
                                self.use_proxy_printer      = result[0].iface_print_via_proxy   || false;
                                self.use_virtual_keyboard   = result[0].iface_vkeyboard         || false;
                                self.use_websql             = result[0].iface_websql            || false;
                                self.use_barcode_scanner    = result[0].iface_barscan           || false;
                                self.use_selfcheckout       = result[0].iface_self_checkout     || false;
                                console.log('POS_CONFIG_DONE');
                            });

                        var bank_def = fetch(
                            'account.bank.statement',
                            ['account_id','currency','journal_id','state','name','user_id','pos_session_id'],
                            [['state','=','open'],['pos_session_id', '=', pos_session.id]]
                            ).then(function(result){
                                self.set({'bank_statements':result});
                                console.log('BANK_DEF_DONE');
                            });

                        var journal_def = fetch(
                            'account.journal',
                            undefined,
                            [['user_id','=',pos_session.user_id[0]]]
                            ).then(function(result){
                                self.set({'journals':result});
                                console.log('JOURNALS_DONE');
                            });

                        // associate the bank statements with their journals. 
                        var bank_process_def = $.when(bank_def, journal_def)
                            .then(function(){
                                var bank_statements = self.get('bank_statements');
                                var journals = self.get('journals');
                                for(var i = 0, ilen = bank_statements.length; i < ilen; i++){
                                    for(var j = 0, jlen = journals.length; j < jlen; j++){
                                        if(bank_statements[i].journal_id[0] === journals[j].id){
                                            bank_statements[i].journal = journals[j];
                                            bank_statements[i].self_checkout_payment_method = journals[j].self_checkout_payment_method;
                                        }
                                    }
                                }
                                console.log('BANK_PROCESS_DONE');
                            });

                        session_data_def = $.when(pos_config_def,bank_def,journal_def,bank_process_def);

                    }else{
                        session_data_def.reject();
                    }
                    return session_data_def;
                });

            // when all the data has loaded, we compute some stuff, and declare the Pos ready to be used. 
            $.when(cat_def, prod_def, user_def, uom_def, session_def, tax_def, prod_process_def, this.get_app_data(), this.flush())
                .then(function(){ 
                    //self.build_tree();
                    self.build_categories(); 
                    self.set({'cashRegisters' : new module.CashRegisterCollection(self.get('bank_statements'))});
                    self.log_loaded_data();
                    self.ready.resolve();
                },function(){
                    //we failed to load some backend data, or the backend was badly configured.
                    //the error messages will be displayed in PosWidget
                    self.ready.reject();
                });
        },

        // logs the usefull posmodel data to the console for debug purposes
        log_loaded_data: function(){
            console.log('PosModel data has been loaded:');
            console.log('PosModel: categories:',this.get('categories'));
            console.log('PosModel: product_list:',this.get('product_list'));
            console.log('PosModel: units:',this.get('units'));
            console.log('PosModel: bank_statements:',this.get('bank_statements'));
            console.log('PosModel: journals:',this.get('journals'));
            console.log('PosModel: taxes:',this.get('taxes'));
            console.log('PosModel: pos_session:',this.get('pos_session'));
            console.log('PosModel: pos_config:',this.get('pos_config'));
            console.log('PosModel: cashRegisters:',this.get('cashRegisters'));
            console.log('PosModel: shop:',this.get('shop'));
            console.log('PosModel: company:',this.get('company'));
            console.log('PosModel: currency:',this.get('currency'));
            console.log('PosModel: user_list:',this.get('user_list'));
            console.log('PosModel: user:',this.get('user'));
            console.log('PosModel.session:',this.session);
            console.log('PosModel.categories:',this.categories);
            console.log('PosModel end of data log.');
        },
        
        // this is called when an order is removed from the order collection. It ensures that there is always an existing
        // order and a valid selected order
        on_removed_order: function(removed_order){
            if( this.get('orders').isEmpty()){
                this.add_and_select_order(new module.Order({ pos: this }));
            }
            if( this.get('selectedOrder') === removed_order){
                this.set({ selectedOrder: this.get('orders').last() });
            }
        },

        // load some data from the server, used in initialize
        get_app_data: function() {
            var self = this;
            return $.when(new instance.web.Model("sale.shop").get_func("search_read")([]).pipe(function(result) {
                self.set({'shop': result[0]});
                var company_id = result[0]['company_id'][0];
                return new instance.web.Model("res.company").get_func("read")(company_id, ['currency_id', 'name', 'phone']).pipe(function(result) {
                    self.set({'company': result});
                    var currency_id = result['currency_id'][0]
                    return new instance.web.Model("res.currency").get_func("read")([currency_id],
                            ['symbol', 'position']).pipe(function(result) {
                        self.set({'currency': result[0]});
                        
                    });
                });
            }), new instance.web.Model("res.users").get_func("read")(this.session.uid, ['name']).pipe(function(result) {
                self.set({'user': result});
            }));
        },

        push_order: function(record) {
            var self = this;
            return this.dao.add_operation(record).pipe(function(){
                    return self.flush();
            });
        },

        add_and_select_order: function(newOrder) {
            (this.get('orders')).add(newOrder);
            return this.set({
                selectedOrder: newOrder
            });
        },
        
        // attemps to send all pending orders ( stored in the DAO ) to the server.
        // it will do it one by one, and remove the successfully sent ones from the DAO once
        // it has been confirmed that they have been received.
        flush: function() {
            //this makes sure only one _int_flush is called at the same time
            return this.flush_mutex.exec(_.bind(function() {
                return this._int_flush();
            }, this));
        },
        _int_flush : function() {
            var self = this;

            this.dao.get_operations().pipe(function(operations) {
                // operations are really Orders that are converted to json.
                // they are saved to disk and then we attempt to send them to the backend so that they can
                // be applied. 
                // since the network is not reliable we potentially have many 'pending operations' that have not been sent.
                self.set( {'nbr_pending_operations':operations.length} );
                if(operations.length === 0){
                    return $.when();
                }
                var order = operations[0];

                 // we prevent the default error handler and assume errors
                 // are a normal use case, except we stop the current iteration

                 return (new instance.web.Model('pos.order')).get_func('create_from_ui')([order])
                            .fail(function(unused, event){
                                // wtf ask niv
                                event.preventDefault();
                            })
                            .pipe(function(){
                                // success: remove the successfully sent operation, and try to send the next one 
                                self.dao.remove_operation(operations[0].id).pipe(function(){
                                    return self._int_flush();
                                });
                            }, function(){
                                // in case of error we just sit there and do nothing. wtf ask niv
                                return $.when();
                            });
            });
        },

        // this adds several properties to the categories in order to make it easier to diplay them
        // fields added include the list of product relevant to each category, list of child categories,
        // list of ancestors, etc.
        build_categories : function(){
            var categories = this.get('categories');
            var products   = this.get('product_list');

            //append the content of array2 into array1
            function append(array1, array2){
                for(var i = 0, len = array2.length; i < len; i++){
                    array1.push(array2[i]);
                }
            }

            function appendSet(set1, set2){
                for(key in set2){
                    set1[key] = set2[key];
                }
            }

            var categories_by_id = {};
            for(var i = 0; i < categories.length; i++){
                categories_by_id[categories[i].id] = categories[i];
            }
            this.categories_by_id = categories_by_id;

            var root_category = {
                name      : 'Root',
                id        : 0,
                parent    : null,
                childrens : [],
            };

            // add parent and childrens field to categories, find root_categories
            for(var i = 0; i < categories.length; i++){
                var cat = categories[i];
                
                cat.parent = categories_by_id[cat.parent_id[0]];
                if(!cat.parent){
                    root_category.childrens.push(cat);
                    cat.parent = root_category;
                }
                
                cat.childrens = [];
                for(var j = 0; j < cat.child_id.length; j++){
                    cat.childrens.push(categories_by_id[ cat.child_id[j] ]);
                }
            }

            categories.push(root_category);

            // set some default fields for next steps
            for(var i = 0; i < categories.length; i++){
                var cat = categories[i];

                cat.product_list = [];  //list of all products in the category
                cat.product_set = {};   // [product.id] === true if product is in category
                cat.weightable_product_list = [];
                cat.weightable_product_set = {};
                cat.weightable = false; //true if directly contains weightable products
            }

            this.root_category = root_category;
            
            //we add the products to the categories. 
            for(var i = 0, len = products.length; i < len; i++){
                var product = products[i];
                var cat = categories_by_id[product.pos_categ_id[0]];
                if(cat){
                    cat.product_list.push(product);
                    cat.product_set[product.id] = true;
                    if(product.to_weight){
                        cat.weightable_product_list.push(product);
                        cat.weightable_product_set[product.id] = true;
                        cat.weightable = true;
                    }
                }
            }

            // we build a flat list of all categories that directly contains weightable products
            this.weightable_categories = [];
            for(var i = 0, len = categories.length; i < len; i++){
                var cat = categories[i];
                if(cat.weightable){
                    this.weightable_categories.push(cat);
                }
            }
            
            // add ancestor field to categories, contains the list of parents of parents, from root to parent
            function make_ancestors(cat, ancestors){
                cat.ancestors = ancestors.slice(0);
                ancestors.push(cat);

                for(var i = 0; i < cat.childrens.length; i++){
                    make_ancestors(cat.childrens[i], ancestors.slice(0));
                }
            }
            
            //add the products of the subcategories to the parent categories
            function make_products(cat){
                for(var i = 0; i < cat.childrens.length; i++){
                    make_products(cat.childrens[i]);

                    append(cat.product_list, cat.childrens[i].product_list);
                    append(cat.weightable_product_list, cat.childrens[i].weightable_product_list);

                    appendSet(cat.product_set, cat.childrens[i].product_set);
                    appendSet(cat.weightable_product_set, cat.childrens[i].weightable_product_set);
                }
            }

            make_ancestors(root_category,[]);
            make_products(root_category);
        },
    });

    module.CashRegister = Backbone.Model.extend({
    });

    module.CashRegisterCollection = Backbone.Collection.extend({
        model: module.CashRegister,
    });

    module.Product = Backbone.Model.extend({
    });

    module.ProductCollection = Backbone.Collection.extend({
        model: module.Product,
    });

    // An orderline represent one element of the content of a client's shopping cart.
    // An orderline contains a product, its quantity, its price, discount. etc. 
    // An Order contains zero or more Orderlines.
    module.Orderline = Backbone.Model.extend({
        initialize: function(options){
            this.pos = options.pos;
            this.order = options.order;
            this.product = options.product;
            this.price   = options.product.get('list_price');
            this.quantity = 1;
            this.discount = 0;
            this.type = 'unit';
            this.selected = false;
        },
        // sets a discount [0,100]%
        set_discount: function(discount){
            this.discount = Math.max(0,Math.min(100,discount));
            this.trigger('change');
        },
        // returns the discount [0,100]%
        get_discount: function(){
            return this.discount;
        },
        // FIXME
        get_product_type: function(){
            return this.type;
        },
        // sets the quantity of the product. The quantity will be rounded according to the 
        // product's unity of measure properties. Quantities greater than zero will not get 
        // rounded to zero
        set_quantity: function(quantity){
            if(_.isNaN(quantity)){
                this.order.removeOrderline(this);
            }else if(quantity !== undefined){
                this.quantity = Math.max(0,quantity);
                var unit = this.get_unit();
                if(unit && this.quantity > 0 ){
                    this.quantity = Math.max(unit.rounding, Math.round(quantity / unit.rounding) * unit.rounding);
                }
            }
            this.trigger('change');
        },
        // return the quantity of product
        get_quantity: function(){
            return this.quantity;
        },
        // return the unit of measure of the product
        get_unit: function(){
            var unit_id = (this.product.get('uos_id') || this.product.get('uom_id'));
            if(!unit_id){
                return undefined;
            }
            unit_id = unit_id[0];
            if(!this.pos){
                return undefined;
            }
            return this.pos.get('units_by_id')[unit_id];
        },
        // return the product of this orderline
        get_product: function(){
            return this.product;
        },
        // return the base price of this product (for this orderline)
        get_list_price: function(){
            return this.price;
        },
        // changes the base price of the product for this orderline
        set_list_price: function(price){
            this.price = price;
            this.trigger('change');
        },
        // selects or deselects this orderline
        set_selected: function(selected){
            this.selected = selected;
            this.trigger('change');
        },
        // returns true if this orderline is selected
        is_selected: function(){
            return this.selected;
        },

        // when we add an new orderline we want to merge it with the last line to see reduce the number of items
        // in the orderline. This returns true if it makes sense to merge the two
        can_be_merged_with: function(orderline){
            if( this.get_product().get('id') !== orderline.get_product().get('id')){    //only orderline of the same product can be merged
                return false;
            }else if(this.get_product_type() !== orderline.get_product_type()){
                return false;
            }else if(this.get_discount() > 0){             // we don't merge discounted orderlines
                return false;
            }else if(this.get_product_type() === 'unit'){ 
                return true;
            }else if(this.get_product_type() === 'weight'){
                return true;
            }else if(this.get_product_type() === 'price'){
                return this.get_product().get('list_price') === orderline.get_product().get('list_price');
            }else{
                console.error('point_of_sale/pos_models.js/Orderline.can_be_merged_with() : unknown product type:',this.get('product_type'));
                return false;
            }
        },
        merge: function(orderline){
            this.set_quantity(this.get_quantity() + orderline.get_quantity());
        },
        export_as_JSON: function() {
            return {
                qty: this.get_quantity(),
                price_unit: this.get_product().get('list_price'),
                discount: this.get_discount(),
                product_id: this.get_product().get('id')
            };
        },
        get_price_without_tax: function(){
            return this.get_all_prices().priceWithoutTax;
        },
        get_price_with_tax: function(){
            return this.get_all_prices().priceWithTax;
        },
        get_tax: function(){
            return this.get_all_prices().tax;
        },
        get_all_prices: function() {
            var self = this;
            var base = this.get_quantity() * this.price * (1 - (this.get_discount() / 100));
            var totalTax = base;
            var totalNoTax = base;
            
            var product_list = this.pos.get('product_list');
            var product =  this.get_product(); 
            var taxes_ids = product.taxes_id;
            var taxes =  self.pos.get('taxes');
            var taxtotal = 0;
            _.each(taxes_ids, function(el) {
                var tax = _.detect(taxes, function(t) {return t.id === el;});
                if (tax.price_include) {
                    var tmp;
                    if (tax.type === "percent") {
                        tmp =  base - (base / (1 + tax.amount));
                    } else if (tax.type === "fixed") {
                        tmp = tax.amount * self.get_quantity();
                    } else {
                        throw "This type of tax is not supported by the point of sale: " + tax.type;
                    }
                    taxtotal += tmp;
                    totalNoTax -= tmp;
                } else {
                    var tmp;
                    if (tax.type === "percent") {
                        tmp = tax.amount * base;
                    } else if (tax.type === "fixed") {
                        tmp = tax.amount * self.get_quantity();
                    } else {
                        throw "This type of tax is not supported by the point of sale: " + tax.type;
                    }
                    taxtotal += tmp;
                    totalTax += tmp;
                }
            });
            return {
                "priceWithTax": totalTax,
                "priceWithoutTax": totalNoTax,
                "tax": taxtotal,
            };
        },
    });

    module.OrderlineCollection = Backbone.Collection.extend({
        model: module.Orderline,
    });

    // Every PaymentLine has all the attributes of the corresponding CashRegister.
    module.Paymentline = Backbone.Model.extend({
        initialize: function(cashRegister) {
            this.amount = 0;
            this.cashregister = cashRegister;
        },
        //sets the amount of money on this payment line
        set_amount: function(value){
            this.amount = value;
            this.trigger('change');
        },
        // returns the amount of money on this paymentline
        get_amount: function(){
            return this.amount;
        },
        // returns the associated cashRegister
        get_cashregister: function(){
            return this.cashregister;
        },
        //exports as JSON for server communication
        export_as_JSON: function(){
            return {
                name: instance.web.datetime_to_str(new Date()),
                statement_id: this.get('id'),
                account_id: (this.get('account_id'))[0],
                journal_id: (this.get('journal_id'))[0],
                amount: this.get_amount()
            };
        },
    });

    module.PaymentlineCollection = Backbone.Collection.extend({
        model: module.Paymentline,
    });
    

    // An order more or less represents the content of a client's shopping cart (the OrderLines) 
    // plus the associated payment information (the PaymentLines) 
    // there is always an active ('selected') order in the Pos, a new one is created
    // automaticaly once an order is completed and sent to the server.
    module.Order = Backbone.Model.extend({
        initialize: function(attributes){
            Backbone.Model.prototype.initialize.apply(this, arguments);
            this.set({
                creationDate:   new Date(),
                orderLines:     new module.OrderlineCollection(),
                paymentLines:   new module.PaymentlineCollection(),
                name:           "Order " + this.generateUniqueId(),
            });
            this.pos =     attributes.pos; //TODO put that in set and remember to use 'get' to read it ... 
            this.pos_widget = attributes.pos_widget;    //FIXME we shouldn't depend on pos_widget in the models
            this.selected_orderline = undefined;
            return this;
        },
        generateUniqueId: function() {
            return new Date().getTime();
        },
        addProduct: function(product){
            var attr = product.toJSON();
            attr.pos = this.pos;
            attr.order = this;
            var line = new module.Orderline({pos: this.pos, order: this, product: product});
            var self = this;

            var last_orderline = this.getLastOrderline();
            if( last_orderline && last_orderline.can_be_merged_with(line) ){
                last_orderline.merge(line);
            }else{
                this.get('orderLines').add(line);
            }
            this.selectLine(this.getLastOrderline());
        },
        removeOrderline: function( line ){
            this.get('orderLines').remove(line);
            this.selectLine(this.getLastOrderline());
        },
        getLastOrderline: function(){
            return this.get('orderLines').at(this.get('orderLines').length -1);
        },
        addPaymentLine: function(cashRegister) {
            var newPaymentline;
            newPaymentline = new module.Paymentline(cashRegister);
            /* TODO: Should be 0 for cash-like accounts */
            //FIXME the following 'set' call calls this method once again via callback
            // events. Are we sure that it's what we want ???
            newPaymentline.set_amount( this.getDueLeft() );
            this.get('paymentLines').add(newPaymentline);
        },
        getName: function() {
            return this.get('name');
        },
        getTotal: function() {
            return (this.get('orderLines')).reduce((function(sum, orderLine) {
                return sum + orderLine.get_price_with_tax();
            }), 0);
        },
        getTotalTaxExcluded: function() {
            return (this.get('orderLines')).reduce((function(sum, orderLine) {
                return sum + orderLine.get_price_without_tax();
            }), 0);
        },
        getTax: function() {
            return (this.get('orderLines')).reduce((function(sum, orderLine) {
                return sum + orderLine.get_tax();
            }), 0);
        },
        getPaidTotal: function() {
            return (this.get('paymentLines')).reduce((function(sum, paymentLine) {
                return sum + paymentLine.get_amount();
            }), 0);
        },
        getChange: function() {
            return this.getPaidTotal() - this.getTotal();
        },
        getDueLeft: function() {
            return this.getTotal() - this.getPaidTotal();
        },
        exportAsJSON: function() {
            var orderLines, paymentLines;
            orderLines = [];
            (this.get('orderLines')).each(_.bind( function(item) {
                return orderLines.push([0, 0, item.export_as_JSON()]);
            }, this));
            paymentLines = [];
            (this.get('paymentLines')).each(_.bind( function(item) {
                return paymentLines.push([0, 0, item.export_as_JSON()]);
            }, this));
            return {
                name: this.getName(),
                amount_paid: this.getPaidTotal(),
                amount_total: this.getTotal(),
                amount_tax: this.getTax(),
                amount_return: this.getChange(),
                lines: orderLines,
                statement_ids: paymentLines,
                pos_session_id: this.pos.get('pos_session').id,
                partner_id: this.pos.get('client') ? this.pos.get('client').id : undefined,
                user_id: this.pos.get('cashier') ? this.pos.get('cashier').id : this.pos.get('user').id,
            };
        },
        getSelectedLine: function(){
            return this.selected_orderline;
        },
        selectLine: function(line){
            if(line){
                if(line !== this.selected_orderline){
                    if(this.selected_orderline){
                        this.selected_orderline.set_selected(false);
                    }
                    this.selected_orderline = line;
                    this.selected_orderline.set_selected(true);
                }
            }else{
                this.selected_orderline = undefined;
            }
        },
            
    });

    module.OrderCollection = Backbone.Collection.extend({
        model: module.Order,
    });

    /*
     The numpad handles both the choice of the property currently being modified
     (quantity, price or discount) and the edition of the corresponding numeric value.
     */
    module.NumpadState = Backbone.Model.extend({
        defaults: {
            buffer: "0",
            mode: "quantity"
        },
        appendNewChar: function(newChar) {
            var oldBuffer;
            oldBuffer = this.get('buffer');
            if (oldBuffer === '0') {
                this.set({
                    buffer: newChar
                });
            } else if (oldBuffer === '-0') {
                this.set({
                    buffer: "-" + newChar
                });
            } else {
                this.set({
                    buffer: (this.get('buffer')) + newChar
                });
            }
            this.updateTarget();
        },
        deleteLastChar: function() {
            var tempNewBuffer = this.get('buffer').slice(0, -1);

            if(!tempNewBuffer){
                this.set({ buffer: "0" });
                this.killTarget();
            }else{
                if (isNaN(tempNewBuffer)) {
                    tempNewBuffer = "0";
                }
                this.set({ buffer: tempNewBuffer });
                this.updateTarget();
            }
        },
        switchSign: function() {
            var oldBuffer;
            oldBuffer = this.get('buffer');
            this.set({
                buffer: oldBuffer[0] === '-' ? oldBuffer.substr(1) : "-" + oldBuffer
            });
            this.updateTarget();
        },
        changeMode: function(newMode) {
            this.set({
                buffer: "0",
                mode: newMode
            });
        },
        reset: function() {
            this.set({
                buffer: "0",
                mode: "quantity"
            });
        },
        updateTarget: function() {
            var bufferContent, params;
            bufferContent = this.get('buffer');
            if (bufferContent && !isNaN(bufferContent)) {
            	this.trigger('set_value', parseFloat(bufferContent));
            }
        },
        killTarget: function(){
            this.trigger('set_value',Number.NaN);
        },
    });
}
